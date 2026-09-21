import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ensureHostResolved } from "./lakebase";
import { buildConsensus, modelAt, type SeriesInput } from "./consensus";
import {
  VARIANTS,
  DEFAULT_VARIANT,
  variantOf,
  MODES,
  MODE_FEATS,
  N_FEAT,
  RIDGE,
  LEAD_BUCKETS,
  leadBucket,
  features,
  priorSigma,
  solve,
  type Mode,
  type ModeFit,
  type ModelParams,
  type SpotParams,
} from "./calib";
import { modelInfo, SPOTS, spotStationIds } from "./spots";
import { TH } from "./kite";
import { waterLookup } from "./watertemp";
import type { Verification, VariantScore } from "./types";

// Lernt je Spot das Nachkorrektur-Modell (calib.ts) aus Modellprognosen vs. Messung und
// prüft es EHRLICH: Für jeden Verifikations-Zeitpunkt F werden die Parameter nur aus
// Messungen VOR F gelernt (rollierend). Daraus:
//   • Wahl der Variante (Korrektur-Modus × Gewichtung) — die einfachste, die innerhalb
//     SELECT_TOL_KN an die beste herankommt
//   • Kalibrierung der Wahrscheinlichkeit (Brier-optimaler Streuungsfaktor)
//   • Nachlauf der Kurzfrist-Korrektur (wie lange hält eine Mess-Abweichung an?)
// Ergebnis: SpotStat.params (für den Konsens) + SpotStat.verification + ModelSkill (Anzeige).

const WINDOW_DAYS = 21; // = Snapshot-Retention
const HALFLIFE_DAYS = 7; // Recency: 7 Tage alte Fehler zählen halb
const AUTOCORR_H = 3; // Stundenfehler sind ~3 h korreliert → effektive Stichprobe = Stunden/3
const RUN_SPACING_H = 6; // je Modell höchstens ein Lauf pro 6 h (Läufe dazwischen sind fast gleich)
const HORIZON_H = 240;
const SIGMA_PRIOR_N = 8; // Pseudo-Stunden des Auflösungs-Priors beim Restfehler
const SERIES_CHUNK = 120;

const VERIF_MAX_SNAPS = 48;
const VERIF_MIN_HISTORY_D = 3; // erst prüfen, wenn davor ≥ 3 Tage gelernt werden konnte
const VERIF_TOL_KN = 3;
const VERIF_LEADS = [
  { leadH: 6, label: "6 h" },
  { leadH: 12, label: "12 h" },
  { leadH: 24, label: "24 h" },
  { leadH: 48, label: "48 h" },
];
const VERIF_CORE_LEAD = 24;
const VERIF_MAX_SCATTER = 400;
// Mindestzahl Vergleiche (24 h), bevor die Daten die Variante wählen dürfen. Benachbarte
// Prognosezeitpunkte prüfen überlappende Stunden → die effektive Stichprobe ist viel kleiner.
const SELECT_MIN_N = 60;
const SELECT_TOL_KN = 0.05;
const SIGMA_SCALES = [0.8, 1, 1.25, 1.5]; // bewusst eng: wenige, stark abhängige Fälle
const PROB_MIN_N = 200;
const NOWCAST_K = 8;
const NOWCAST_PRIOR_TAU = 3;
const NOWCAST_PRIOR_N = 5;

const hourTs = (sec: number) => Math.floor(sec / 3600) * 3600;
const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

type DbModel = {
  idModel: number;
  modelName: string;
  modelLongname?: string | null;
  resolution: number | null;
  koef: number;
  initStamp: number;
  series: unknown;
};

function toSeriesInput(m: DbModel): SeriesInput {
  return {
    idModel: m.idModel,
    modelName: m.modelName,
    resolution: m.resolution,
    koef: m.koef,
    initStamp: m.initStamp,
    series: m.series as SeriesInput["series"],
  };
}

export type SkillRow = {
  idModel: number;
  label: string;
  resolution: number | null;
  mae: number | null; // roher Ø Fehler (Vorlauf < 48 h), recency-gewichtet
  bias: number | null; // roher Bias (Prognose − Messung), Vorlauf < 48 h
  samples: number; // effektive Stichprobe (dedupliziert, autokorrelationsbereinigt)
  score: number; // Konsens-Gewicht 1/σ² (Vorlauf 0–24 h, gewählte Variante)
};

// ── Suffiziente Statistiken je (Modell, Vorlauf-Stufe) ──────────────────────────────────
// Recency-Gewicht 0.5^((F−t)/H) = 2^(−F/H) · 2^(t/H): die Summen mit 2^(t/H) sind kumulativ,
// je Stichtag F wird nur skaliert. So kostet die rollierende Anpassung fast nichts extra.
type Stats = { A: Float64Array; b: Float64Array; yy: number; sw: number };
const newStats = (): Stats => ({ A: new Float64Array(N_FEAT * N_FEAT), b: new Float64Array(N_FEAT), yy: 0, sw: 0 });

function addSample(st: Stats, x: number[], y: number, u: number) {
  for (let i = 0; i < N_FEAT; i++) {
    if (x[i] === 0) continue;
    st.b[i] += u * x[i] * y;
    for (let j = 0; j < N_FEAT; j++) st.A[i * N_FEAT + j] += u * x[i] * x[j];
  }
  st.yy += u * y * y;
  st.sw += u;
}

function fitMode(st: Stats | undefined, scale: number, mode: Mode, res: number | null, bucket: number): ModeFit {
  const sp = priorSigma(res, bucket);
  const beta = new Array(N_FEAT).fill(0);
  if (!st || st.sw * scale <= 0) return { beta, sigma: sp };
  const feats = MODE_FEATS[mode];
  const yy = st.yy * scale;
  let rss = yy;
  if (feats.length) {
    const A = feats.map((i) => feats.map((j) => st.A[i * N_FEAT + j] * scale + (i === j ? RIDGE[i] : 0)));
    const b = feats.map((i) => st.b[i] * scale);
    const sol = solve(A, b);
    feats.forEach((f, k) => (beta[f] = sol[k]));
    // RSS = yy − 2βᵀb + βᵀ(XᵀWX)β  (ohne Ridge-Anteil)
    let bb = 0;
    let quad = 0;
    for (const i of feats) {
      bb += beta[i] * st.b[i] * scale;
      for (const j of feats) quad += beta[i] * beta[j] * st.A[i * N_FEAT + j] * scale;
    }
    rss = Math.max(0, yy - 2 * bb + quad);
  }
  const sw = st.sw * scale;
  const sigma = Math.sqrt((rss + SIGMA_PRIOR_N * sp * sp) / (sw + SIGMA_PRIOR_N));
  return { beta: beta.map(round3), sigma: round3(sigma) };
}

type ModelMeta = { idModel: number; label: string; resolution: number | null };

function fitAll(stats: Map<number, Stats>, metas: ModelMeta[], scale: number): Record<string, ModelParams> {
  const out: Record<string, ModelParams> = {};
  metas.forEach((mm, mi) => {
    const fits: Record<Mode, ModeFit>[] = [];
    const n: number[] = [];
    for (let bk = 0; bk < LEAD_BUCKETS; bk++) {
      const st = stats.get(mi * LEAD_BUCKETS + bk);
      n.push(round1((st?.sw ?? 0) * scale));
      fits.push(
        Object.fromEntries(MODES.map((mo) => [mo, fitMode(st, scale, mo, mm.resolution, bk)])) as Record<Mode, ModeFit>,
      );
    }
    out[String(mm.idModel)] = { resolution: mm.resolution, n, fits };
  });
  return out;
}

// ── Hauptrechnung ────────────────────────────────────────────────────────────────────────

type Result = { skill: SkillRow[]; verification: Verification | null; params: SpotParams | null };

async function computeSpot(spotId: number): Promise<Result | null> {
  const stationIds = spotStationIds(spotId);
  if (!stationIds.length) return null;

  const nowSec = Date.now() / 1000;
  const winStartSec = nowSec - WINDOW_DAYS * 86400;
  const H = HALFLIFE_DAYS * 86400;
  const T0 = winStartSec;
  const growth = (t: number) => Math.pow(2, (t - T0) / H) / AUTOCORR_H;
  const scaleAt = (F: number) => Math.pow(2, -(F - T0) / H);

  // Gemessener Wind je Stunde (nur aktuell definierte Stationen).
  const obs = await prisma.stationObs.findMany({
    where: { spotId, stationId: { in: stationIds }, obsTime: { gte: new Date(winStartSec * 1000) }, windAvg: { not: null } },
    select: { obsTime: true, windAvg: true },
  });
  const mh = new Map<number, { sum: number; n: number }>();
  for (const o of obs) {
    const k = hourTs(Math.floor(o.obsTime.getTime() / 1000));
    const c = mh.get(k);
    if (c) {
      c.sum += o.windAvg!;
      c.n += 1;
    } else mh.set(k, { sum: o.windAvg!, n: 1 });
  }
  const measuredAt = (k: number): number | null => {
    const m = mh.get(k);
    return m ? m.sum / m.n : null;
  };
  const measuredHours = [...mh.keys()].sort((a, b) => a - b);
  if (!measuredHours.length) return { skill: [], verification: null, params: null };
  // Gemessene Wassertemperatur (Rijkswaterstaat) zum Zeitpunkt; sonst Windguru-Schätzung.
  const waterAt = await waterLookup(spotId, new Date(winStartSec * 1000));

  // ── 1. Modellläufe deduplizieren: je (Modell, initStamp) einmal, höchstens alle 6 h ─────
  const rows = await prisma.modelSeries.findMany({
    where: { snapshot: { spotId, ok: true, fetchedAt: { gte: new Date(winStartSec * 1000) } } },
    select: {
      id: true,
      idModel: true,
      initStamp: true,
      resolution: true,
      snapshot: { select: { fetchedAt: true, waterTemp: true } },
    },
  });
  rows.sort((a, b) => a.idModel - b.idModel || a.initStamp - b.initStamp || a.snapshot.fetchedAt.getTime() - b.snapshot.fetchedAt.getTime());
  const picked: { id: string; water: number | null }[] = [];
  const metas: ModelMeta[] = [];
  const metaIdx = new Map<number, number>();
  let lastModel = -1;
  let lastInit = -Infinity;
  for (const r of rows) {
    if (!metaIdx.has(r.idModel)) {
      metaIdx.set(r.idModel, metas.length);
      metas.push({ idModel: r.idModel, label: modelInfo(r.idModel, r.resolution).label, resolution: r.resolution });
    }
    if (r.idModel !== lastModel) {
      lastModel = r.idModel;
      lastInit = -Infinity;
    }
    if (r.initStamp - lastInit < RUN_SPACING_H * 3600) continue; // gleicher/zu naher Lauf
    lastInit = r.initStamp;
    picked.push({ id: r.id, water: r.snapshot.waterTemp });
  }

  // ── 2. Fehler-Stichproben (kompakt in Spalten) ──────────────────────────────────────────
  const S = { t: [] as number[], key: [] as number[], y: [] as number[], x: [] as number[][], short: [] as boolean[] };
  const firstIdx = (t: number) => {
    let lo = 0;
    let hi = measuredHours.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (measuredHours[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let c = 0; c < picked.length; c += SERIES_CHUNK) {
    const chunk = picked.slice(c, c + SERIES_CHUNK);
    const water = new Map(chunk.map((p) => [p.id, p.water]));
    const series = await prisma.modelSeries.findMany({
      where: { id: { in: chunk.map((p) => p.id) } },
      select: { id: true, idModel: true, modelName: true, resolution: true, koef: true, initStamp: true, series: true },
    });
    for (const dm of series) {
      const si = toSeriesInput(dm);
      const mi = metaIdx.get(dm.idModel)!;
      const w = water.get(dm.id) ?? null;
      for (let i = firstIdx(dm.initStamp); i < measuredHours.length; i++) {
        const t = measuredHours[i];
        const leadH = (t - dm.initStamp) / 3600;
        if (leadH > HORIZON_H) break;
        const at = modelAt(si, t);
        if (at.wind == null) continue;
        const wt = waterAt(t) ?? w;
        const dT = wt != null && at.tmp != null ? wt - at.tmp : null;
        S.t.push(t);
        S.key.push(mi * LEAD_BUCKETS + leadBucket(leadH));
        S.y.push(at.wind - measuredAt(t)!);
        S.x.push(features(at.wind, at.dir, dT));
        S.short.push(leadH < 48);
      }
    }
  }
  const order = S.t.map((_, i) => i).sort((a, b) => S.t[a] - S.t[b]);

  // ── 3. Verifikations-Stichtage (ganze Snapshots, zum Nachrechnen des Konsens) ──────────
  const snapMeta = await prisma.snapshot.findMany({
    where: {
      spotId,
      ok: true,
      fetchedAt: {
        gte: new Date((winStartSec + VERIF_MIN_HISTORY_D * 86400) * 1000),
        lte: new Date((nowSec - 6 * 3600) * 1000),
      },
    },
    orderBy: { fetchedAt: "asc" },
    select: { id: true },
  });
  const step = Math.max(1, Math.ceil(snapMeta.length / VERIF_MAX_SNAPS));
  const verifIds = snapMeta.filter((_, i) => i % step === 0).map((s) => s.id);

  // Akkus je Variante
  type LeadAcc = { abs: number; err: number; hit: number; n: number };
  const vAcc = new Map<string, LeadAcc[]>(VARIANTS.map((v) => [v.key, VERIF_LEADS.map(() => ({ abs: 0, err: 0, hit: 0, n: 0 }))]));
  const scatter = new Map<string, { forecast: number; measured: number; leadH: number }[]>(VARIANTS.map((v) => [v.key, []]));
  // Wahrscheinlichkeit: je Variante × Streuungsfaktor die (p, o)-Paare; dazu der harte Anteil.
  const probRec = new Map<string, { p: number; o: number }[][]>(VARIANTS.map((v) => [v.key, SIGMA_SCALES.map(() => [])]));
  const fracRec = new Map<string, { p: number; o: number }[]>(VARIANTS.map((v) => [v.key, []]));
  // Nowcast: Fehler zum Stichtag e0 und k Stunden später
  const ncPairs = new Map<string, { e0: number; ek: (number | null)[] }[]>(VARIANTS.map((v) => [v.key, []]));

  const stats = new Map<number, Stats>();
  let ptr = 0;
  const advanceTo = (F: number) => {
    // Nur Stunden, deren Messung zum Stichtag F schon vorlag.
    while (ptr < order.length && S.t[order[ptr]] + 3600 <= F) {
      const i = order[ptr++];
      let st = stats.get(S.key[i]);
      if (!st) stats.set(S.key[i], (st = newStats()));
      addSample(st, S.x[i], S.y[i], growth(S.t[i]));
    }
  };

  for (let c = 0; c < verifIds.length; c += 8) {
    const snaps = await prisma.snapshot.findMany({
      where: { id: { in: verifIds.slice(c, c + 8) } },
      orderBy: { fetchedAt: "asc" },
      include: { models: true },
    });
    for (const snap of snaps) {
      if (!snap.models.length) continue;
      const F = Math.floor(snap.fetchedAt.getTime() / 1000);
      advanceTo(F);
      const paramsF: SpotParams = {
        variant: DEFAULT_VARIANT,
        models: fitAll(stats, metas, scaleAt(F)),
        sigmaScale: 1,
        nowcastGain: [],
        fittedAt: F,
      };
      const inputs = snap.models.map(toSeriesInput);
      const base = hourTs(F);
      const ncGrid = Array.from({ length: NOWCAST_K + 1 }, (_, k) => base + k * 3600);
      const leadGrid = VERIF_LEADS.map((l) => base + l.leadH * 3600);
      const grid = [...new Set([...ncGrid, ...leadGrid])].sort((a, b) => a - b);

      for (const v of VARIANTS) {
        const cons = buildConsensus(inputs, F, paramsF, { grid, variant: v.key, waterTemp: waterAt(F) ?? snap.waterTemp, probAt: TH.min });
        const at = new Map(cons.points.map((p) => [p.t, p]));
        const acc = vAcc.get(v.key)!;
        VERIF_LEADS.forEach((l, li) => {
          const t = base + l.leadH * 3600;
          const p = at.get(t);
          const meas = measuredAt(t);
          if (p?.windspd == null || meas == null) return;
          const err = p.windspd - meas;
          const a = acc[li];
          a.abs += Math.abs(err);
          a.err += err;
          if (Math.abs(err) <= VERIF_TOL_KN) a.hit += 1;
          a.n += 1;
          const sc = scatter.get(v.key)!;
          if (l.leadH === VERIF_CORE_LEAD && sc.length < VERIF_MAX_SCATTER) {
            sc.push({ forecast: round1(p.windspd), measured: round1(meas), leadH: l.leadH });
          }
          if (p.pFrac != null) fracRec.get(v.key)!.push({ p: p.pFrac, o: meas >= TH.min ? 1 : 0 });
        });
        // Nowcast-Paare
        const m0 = measuredAt(base);
        const c0 = at.get(base)?.windspd;
        if (m0 != null && c0 != null) {
          const ek = Array.from({ length: NOWCAST_K + 1 }, (_, k) => {
            const mk = measuredAt(base + k * 3600);
            const ck = at.get(base + k * 3600)?.windspd;
            return mk != null && ck != null ? mk - ck : null;
          });
          ncPairs.get(v.key)!.push({ e0: m0 - c0, ek });
        }
        // Wahrscheinlichkeit je Streuungsfaktor (nur die Vorlauf-Stunden)
        SIGMA_SCALES.forEach((s, si) => {
          const cp = buildConsensus(inputs, F, { ...paramsF, sigmaScale: s }, {
            grid: leadGrid,
            variant: v.key,
            waterTemp: waterAt(F) ?? snap.waterTemp,
            probAt: TH.min,
          });
          for (const p of cp.points) {
            const meas = measuredAt(p.t);
            if (p.pAbove == null || meas == null) continue;
            probRec.get(v.key)![si].push({ p: p.pAbove, o: meas >= TH.min ? 1 : 0 });
          }
        });
      }
    }
  }

  // ── 4. Variante wählen ─────────────────────────────────────────────────────────────────
  const variantScores: VariantScore[] = VARIANTS.map((v) => {
    const acc = vAcc.get(v.key)!;
    const leads = VERIF_LEADS.map((l, li) => ({
      leadH: l.leadH,
      n: acc[li].n,
      mae: acc[li].n ? round1(acc[li].abs / acc[li].n) : null,
    }));
    const withData = acc.filter((a) => a.n > 0);
    const meanMae = withData.length ? withData.reduce((s, a) => s + a.abs / a.n, 0) / withData.length : null;
    return { key: v.key, label: v.label, meanMae: meanMae == null ? null : Math.round(meanMae * 100) / 100, leads };
  });
  const n24 = vAcc.get(DEFAULT_VARIANT)![VERIF_LEADS.findIndex((l) => l.leadH === VERIF_CORE_LEAD)].n;
  let chosen = DEFAULT_VARIANT;
  if (n24 >= SELECT_MIN_N) {
    const scored = variantScores.filter((v) => v.meanMae != null);
    const best = Math.min(...scored.map((v) => v.meanMae!));
    chosen = scored.find((v) => v.meanMae! <= best + SELECT_TOL_KN)?.key ?? DEFAULT_VARIANT;
  }

  // ── 5. Wahrscheinlichkeit kalibrieren (Brier) ──────────────────────────────────────────
  const brier = (xs: { p: number; o: number }[]) => (xs.length ? xs.reduce((s, x) => s + (x.p - x.o) ** 2, 0) / xs.length : null);
  const recs = probRec.get(chosen)!;
  const nProb = recs[SIGMA_SCALES.indexOf(1)].length;
  let bestScaleIdx = SIGMA_SCALES.indexOf(1);
  if (nProb >= PROB_MIN_N) {
    recs.forEach((r, i) => {
      if ((brier(r) ?? Infinity) < (brier(recs[bestScaleIdx]) ?? Infinity)) bestScaleIdx = i;
    });
  }
  const sigmaScale = SIGMA_SCALES[bestScaleIdx];
  const dressed = recs[bestScaleIdx];
  const baseRate = dressed.length ? dressed.reduce((s, x) => s + x.o, 0) / dressed.length : null;
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const reliability = bins.slice(0, -1).map((lo, i) => {
    const inBin = dressed.filter((x) => x.p >= lo && x.p < bins[i + 1]);
    return {
      lo,
      hi: Math.min(1, bins[i + 1]),
      n: inBin.length,
      pAvg: inBin.length ? round3(inBin.reduce((s, x) => s + x.p, 0) / inBin.length) : null,
      obsFreq: inBin.length ? round3(inBin.reduce((s, x) => s + x.o, 0) / inBin.length) : null,
    };
  });

  // ── 6. Nachlauf der Kurzfrist-Korrektur: gain_k = Regression von e_k auf e_0 ────────────
  const pairs = ncPairs.get(chosen)!;
  const v0 = pairs.length ? pairs.reduce((s, p) => s + p.e0 * p.e0, 0) / pairs.length : 4;
  const gain: number[] = [1];
  for (let k = 1; k <= NOWCAST_K; k++) {
    let sxy = 0;
    let sxx = 0;
    for (const p of pairs) {
      const ek = p.ek[k];
      if (ek == null) continue;
      sxy += p.e0 * ek;
      sxx += p.e0 * p.e0;
    }
    const prior = Math.exp(-k / NOWCAST_PRIOR_TAU);
    const g = (sxy + NOWCAST_PRIOR_N * v0 * prior) / (sxx + NOWCAST_PRIOR_N * v0);
    gain.push(round3(Math.max(0, Math.min(gain[k - 1], g)))); // monoton fallend, 0..1
  }
  let halfLifeH: number | null = null;
  for (let k = 1; k <= NOWCAST_K; k++) {
    if (gain[k] <= 0.5) {
      halfLifeH = round1(k - 1 + (gain[k - 1] - 0.5) / Math.max(1e-6, gain[k - 1] - gain[k]));
      break;
    }
  }

  // ── 7. Endgültige Parameter mit ALLEN Messungen ────────────────────────────────────────
  advanceTo(Infinity);
  const params: SpotParams = {
    variant: chosen,
    models: fitAll(stats, metas, scaleAt(nowSec)),
    sigmaScale,
    nowcastGain: gain,
    fittedAt: Math.round(nowSec),
  };

  // Anzeige-Kennzahlen je Modell (roh, Vorlauf < 48 h) + Gewicht der gewählten Variante.
  const scaleNow = scaleAt(nowSec);
  const disp = metas.map(() => ({ sw: 0, abs: 0, err: 0 }));
  for (let i = 0; i < S.t.length; i++) {
    if (!S.short[i]) continue;
    const d = disp[Math.floor(S.key[i] / LEAD_BUCKETS)];
    const u = growth(S.t[i]) * scaleNow;
    d.sw += u;
    d.abs += u * Math.abs(S.y[i]);
    d.err += u * S.y[i];
  }
  const mode = variantOf(chosen).mode;
  const skill: SkillRow[] = metas.map((mm, mi) => {
    const d = disp[mi];
    const sig = params.models[String(mm.idModel)].fits[0][mode].sigma;
    return {
      idModel: mm.idModel,
      label: mm.label,
      resolution: mm.resolution,
      mae: d.sw > 0 ? round1(d.abs / d.sw) : null,
      bias: d.sw > 0 ? round1(d.err / d.sw) : null,
      samples: round1(d.sw),
      score: 1 / (sig * sig),
    };
  });
  skill.sort((a, b) => b.score - a.score);

  // ── 8. Verifikations-Blob (gewählte Variante) ──────────────────────────────────────────
  const cAcc = vAcc.get(chosen)!;
  const leads = VERIF_LEADS.map((l, li) => {
    const a = cAcc[li];
    return {
      leadH: l.leadH,
      label: l.label,
      n: a.n,
      mae: a.n ? round1(a.abs / a.n) : null,
      bias: a.n ? round1(a.err / a.n) : null,
      hit: a.n ? Math.round((a.hit / a.n) * 100) / 100 : null,
    };
  });
  const verification: Verification | null = leads.every((l) => l.n === 0)
    ? null
    : {
        windowDays: WINDOW_DAYS,
        hitToleranceKn: VERIF_TOL_KN,
        obsHours: mh.size,
        leads,
        scatter: scatter.get(chosen)!,
        outOfSample: true,
        snapshots: verifIds.length,
        chosen,
        variants: variantScores,
        prob:
          nProb > 0
            ? {
                threshold: TH.min,
                n: nProb,
                sigmaScale,
                brierDressed: round3(brier(dressed)!),
                brierFraction: round3(brier(fracRec.get(chosen)!) ?? 0),
                brierClimate: baseRate == null ? null : round3(baseRate * (1 - baseRate)),
                reliability,
              }
            : null,
        nowcast: { gain, pairs: pairs.length, halfLifeH },
      };

  return { skill, verification, params };
}

/** Berechnet die Güte eines Spots und schreibt sie in `ModelSkill`/`SpotStat`. */
async function persistSpotSkill(spotId: number): Promise<void> {
  const res = await computeSpot(spotId);
  if (!res) return;
  const { skill, verification, params } = res;
  const vJson = verification == null ? Prisma.JsonNull : (verification as unknown as Prisma.InputJsonValue);
  const pJson = params == null ? Prisma.JsonNull : (params as unknown as Prisma.InputJsonValue);

  await prisma.$transaction([
    ...skill.map((s) =>
      prisma.modelSkill.upsert({
        where: { spotId_idModel: { spotId, idModel: s.idModel } },
        create: { spotId, ...s },
        update: { label: s.label, resolution: s.resolution, mae: s.mae, bias: s.bias, samples: s.samples, score: s.score },
      }),
    ),
    prisma.spotStat.upsert({
      where: { spotId },
      create: { spotId, verification: vJson, params: pJson },
      update: { verification: vJson, params: pJson },
    }),
  ]);
}

let recomputing = false;

/**
 * Erneuert die materialisierte Güte ALLER Spots. Läuft im Hintergrund (App-Start, nach
 * jedem Abruf, Intervall), nie im Request-Pfad. Doppelläufe werden verhindert.
 */
export async function recomputeSkill(): Promise<void> {
  if (recomputing) return;
  recomputing = true;
  try {
    await ensureHostResolved();
    for (const s of SPOTS) {
      try {
        const t0 = Date.now();
        await persistSpotSkill(s.id);
        console.log(`[skill] Spot ${s.id} in ${Date.now() - t0} ms`);
      } catch (e) {
        console.error(`[skill] Spot ${s.id}:`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    recomputing = false;
  }
}

/**
 * Startet die Hintergrund-Erneuerung, unabhängig vom Forecast-Poller (auf Databricks ist die
 * Erfassung ein separater Python-Job). Ein globaler Marker verhindert Doppelstart.
 */
export function startSkillRefresher() {
  const g = globalThis as unknown as { __wgSkillStarted?: boolean };
  if (g.__wgSkillStarted) return;
  g.__wgSkillStarted = true;
  const min = Math.max(15, Number(process.env.SKILL_REFRESH_MIN ?? 60));
  const run = (reason: string) =>
    recomputeSkill()
      .then(() => console.log(`[skill] materialisiert (${reason})`))
      .catch((e) => console.error("[skill] Fehler:", e instanceof Error ? e.message : e));
  setTimeout(() => void run("start"), 8000);
  setInterval(() => void run("intervall"), min * 60 * 1000);
  console.log(`[skill] Erneuerung aktiv — Intervall ${min} min`);
}

/** Liest die materialisierten Güte-Zeilen eines Spots (Anzeige). */
export async function loadSkillRows(spotId: number): Promise<SkillRow[]> {
  const rows = await prisma.modelSkill.findMany({ where: { spotId } });
  return rows.map((r) => ({
    idModel: r.idModel,
    label: r.label,
    resolution: r.resolution,
    mae: r.mae,
    bias: r.bias,
    samples: r.samples,
    score: r.score,
  }));
}

/** Gelernte Parameter eines Spots (für den Konsens); null = noch keine → Prior. */
export async function loadSpotParams(spotId: number): Promise<SpotParams | null> {
  const s = await prisma.spotStat.findUnique({ where: { spotId }, select: { params: true } });
  return (s?.params as unknown as SpotParams | null) ?? null;
}
