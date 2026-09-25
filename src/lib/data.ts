import "server-only";
import { prisma } from "./prisma";
import { ensureHostResolved } from "./lakebase";
import { buildConsensus, modelHourly, modelOnGrid, type SeriesInput, type ConsensusPoint } from "./consensus";
import { loadSkillRows } from "./skill";
import { loadWaterTemps } from "./watertemp";
import { variantOf, priorSigma, LEAD_LABELS, LEAD_BUCKETS, MAX_CORR_KN, type SpotParams, type Variant } from "./calib";
import { modelInfo, SPOTS, spotStationIds } from "./spots";
import { topKMean } from "./units";
import { sunTimes, isDaylight } from "./sun";
import type {
  ModelView,
  SkillView,
  TrendRun,
  DailyTrend,
  TrendDelta,
  SpotPayload,
  StationView,
  Verification,
  ModelVerification,
  Nowcast,
  PastForecast,
  LearnedView,
} from "./types";

// Zeitfenster der Live-Messungen, das gegen die Prognose gelegt wird.
const OBS_WINDOW_H = 24;
// Alter des Datenstands, dessen Prognose im Verlauf gegen die Messung gelegt wird.
const PAST_FORECAST_H = 24;

/** Lädt die jüngsten Messungen ALLER Stationen eines Spots als StationView[]. */
async function buildStations(spotId: number): Promise<StationView[]> {
  const def = SPOTS.find((s) => s.id === spotId);
  if (!def?.stations?.length) return [];

  const since = new Date(Date.now() - OBS_WINDOW_H * 3600 * 1000);
  const obs = await prisma.stationObs.findMany({
    where: { spotId, obsTime: { gte: since } },
    orderBy: { obsTime: "asc" },
  });

  return def.stations.map((st) => {
    const rows = obs.filter((o) => o.stationId === st.id);
    const series = rows.map((o) => ({
      t: Math.round(o.obsTime.getTime() / 1000),
      windAvg: o.windAvg,
      windMax: o.windMax,
      windDir: o.windDir,
    }));
    const last = rows.at(-1) ?? null;
    return {
      id: st.id,
      name: st.name,
      obsTime: last?.obsTime.toISOString() ?? null,
      ageMin: last ? Math.round((Date.now() - last.obsTime.getTime()) / 60000) : null,
      windAvg: last?.windAvg ?? null,
      windMax: last?.windMax ?? null,
      windMin: last?.windMin ?? null,
      windDir: last?.windDir ?? null,
      temp: last?.temp ?? null,
      series,
    };
  });
}

// Kadenzen für die Trend-Änderung der Tages-Spitze (kurzfristig 6 h statt 3 h).
// „1 T" speist die Markierung „stabil / steigt / fällt seit gestern" auf den Tageskarten.
const CADENCES: { key: string; label: string; hours: number }[] = [
  { key: "d6h", label: "6 h", hours: 6 },
  { key: "d1d", label: "1 T", hours: 24 },
  { key: "d3d", label: "3 T", hours: 72 },
  { key: "d7d", label: "7 T", hours: 168 },
];

const TZ = "Europe/Amsterdam";
const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

function dayKey(sec: number): string {
  return dayFmt.format(new Date(sec * 1000));
}

type DbModel = {
  idModel: number;
  modelName: string;
  modelLongname: string | null;
  resolution: number | null;
  koef: number;
  initStamp: number;
  series: unknown;
};

// Die Reihen eines Abrufs: jede Modell-Reihe liegt einmal in ModelRun, der Abruf verweist
// über SnapshotRun darauf (samt Windguru-Blend-Gewicht `koef` zum Abrufzeitpunkt).
const WITH_RUNS = { runs: { include: { run: true } } } as const;
type SnapRuns = { runs: { koef: number; run: Omit<DbModel, "koef"> }[] };
const modelsOf = (snap: SnapRuns): DbModel[] => snap.runs.map((x) => ({ ...x.run, koef: x.koef }));

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

const dowFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });

function dayLabel(sec: number): string {
  return dowFmt.format(new Date(sec * 1000)).replace(",", "");
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// Modell-Check-Fenster (on-demand je Tag). Die materialisierte Konsens-Verifikation und
// Modell-Güte liegen in skill.ts (ModelSkill/SpotStat), nicht mehr im Request-Pfad.
const VERIF_WINDOW_DAYS = 21;
const hourTs = (sec: number) => Math.floor(sec / 3600) * 3600;

/**
 * Tages-Kennwert je Tag aus einer Konsens-Reihe: `peak` ist der **Ø der 3 stärksten
 * Tageslicht-Stunden** (nicht eine einzelne Spitze — die ist für einen ganzen Tag nicht
 * aussagekräftig; Nachtstunden kann niemand fahren), `gust` analog der Ø der 3 stärksten
 * Böen-Stunden. `dir`/`at` markieren die stärkste Einzelstunde (für Pfeil/Label).
 */
function dailyPeaks(points: ConsensusPoint[], lat: number, lon: number) {
  const byDay = new Map<string, ConsensusPoint[]>();
  const sunCache = new Map<string, { rise: number; set: number }>();
  for (const p of points) {
    if (p.windspd == null) continue;
    const k = dayKey(p.t);
    let sun = sunCache.get(k);
    if (!sun) sunCache.set(k, (sun = sunTimes(lat, lon, k)));
    if (!isDaylight(p.t, sun)) continue;
    const arr = byDay.get(k);
    if (arr) arr.push(p);
    else byDay.set(k, [p]);
  }

  const map = new Map<string, { peak: number; gust: number; dir: number | null; at: number }>();
  for (const [k, pts] of byDay) {
    const peak = topKMean(pts.map((p) => p.windspd), 3);
    if (peak == null) continue;
    const gust = topKMean(pts.map((p) => p.gust), 3) ?? peak;
    const strongest = pts.reduce((a, b) => ((b.windspd ?? 0) > (a.windspd ?? 0) ? b : a));
    map.set(k, { peak: round1(peak), gust: round1(gust), dir: strongest.winddir, at: strongest.t });
  }
  return map;
}

// Kurzfrist-Korrektur: Messung darf höchstens so alt sein; Abklingzeit der Abweichung.
const NOWCAST_MAX_AGE_MIN = 90;
// Standard-Nachlauf ohne gelernte Werte: e^(−k/3) — halbiert sich nach ~2 h.
const DEFAULT_GAIN = Array.from({ length: 9 }, (_, k) => Math.round(Math.exp(-k / 3) * 1000) / 1000);

/**
 * Abweichung Messung − Prognose zum jüngsten Messzeitpunkt (erste Station mit frischen
 * Daten). Gemessen = Ø der letzten 60 min, damit eine einzelne Böe nicht alles verschiebt.
 */
function buildNowcast(
  stations: StationView[],
  points: ConsensusPoint[],
  gainIn: number[] | undefined,
): Nowcast | null {
  const gain = gainIn?.length ? gainIn : DEFAULT_GAIN;
  let halfLifeH: number | null = null;
  for (let k = 1; k < gain.length; k++) {
    if (gain[k] <= 0.5) {
      halfLifeH = round1(k - 1 + (gain[k - 1] - 0.5) / Math.max(1e-6, gain[k - 1] - gain[k]));
      break;
    }
  }
  for (const st of stations) {
    if (st.ageMin == null || st.ageMin > NOWCAST_MAX_AGE_MIN || !st.series.length) continue;
    const t0 = st.series[st.series.length - 1].t;
    const recent = st.series.filter((o) => o.t >= t0 - 3600 && o.windAvg != null);
    if (!recent.length) continue;
    const measured = recent.reduce((a, o) => a + (o.windAvg as number), 0) / recent.length;
    const forecast = consensusAt(points, t0);
    if (forecast == null) continue;
    return {
      station: st.name,
      t0,
      measured: round1(measured),
      forecast: round1(forecast),
      offset: round1(measured - forecast),
      gain,
      halfLifeH,
    };
  }
  return null;
}

/** Konsens-Wind zum Zeitpunkt t (linear zwischen den Stundenwerten; vor Gitterbeginn = 1. Wert). */
function consensusAt(points: ConsensusPoint[], t: number): number | null {
  const pts = points.filter((p) => p.windspd != null);
  if (!pts.length) return null;
  if (t <= pts[0].t) return pts[0].windspd;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.windspd! + ((b.windspd! - a.windspd!) * (t - a.t)) / (b.t - a.t);
    }
  }
  return null;
}

function nowPoint(points: ConsensusPoint[]): ConsensusPoint | null {
  if (!points.length) return null;
  const now = Date.now() / 1000;
  return points.find((p) => p.t >= now) ?? points[points.length - 1];
}

async function buildSpotPayload(spot: {
  id: number;
  slug: string;
  name: string;
  region: string | null;
  lat: number | null;
  lon: number | null;
}): Promise<SpotPayload> {
  // Letzter Snapshot + Modelle.
  const latest = await prisma.snapshot.findFirst({
    where: { spotId: spot.id, ok: true, runs: { some: {} } },
    orderBy: { fetchedAt: "desc" },
    include: WITH_RUNS,
  });

  // Materialisierte Güte + Verifikation lesen (im Hintergrund berechnet, s. skill.ts) —
  // KEIN Neuaufbau über die Snapshot-Historie im Request-Pfad.
  const [stations, skillRows, spotStat, water] = await Promise.all([
    buildStations(spot.id),
    loadSkillRows(spot.id),
    prisma.spotStat.findUnique({ where: { spotId: spot.id } }),
    loadWaterTemps(spot.id),
  ]);
  const verification = (spotStat?.verification ?? null) as Verification | null;
  const params = (spotStat?.params ?? null) as unknown as SpotParams | null;
  const variant = variantOf(params?.variant);
  const def = SPOTS.find((s) => s.id === spot.id);
  const lat = spot.lat ?? def?.lat ?? 52.5;
  const lon = spot.lon ?? def?.lon ?? 4.5;
  const skillById = new Map(skillRows.map((r) => [r.idModel, r]));

  const base: SpotPayload = {
    id: spot.id,
    slug: spot.slug,
    name: spot.name,
    region: spot.region,
    lat,
    lon,
    dirs: def?.dirs ?? { good: [[0, 360]], ok: [] },
    fetchedAt: null,
    sunrise: null,
    sunset: null,
    waterTemp: null,
    water,
    timezone: null,
    now: null,
    nowcast: null,
    method: {
      variant: variant.key,
      label: variant.label,
      sigmaScale: params?.sigmaScale ?? 1,
      fittedAt: params?.fittedAt ?? null,
    },
    points: [],
    gridTimes: [],
    models: [],
    skill: [],
    contributors: [],
    trend: { runs: [], daily: [], refFetchedAt: null },
    pastForecast: null,
    stations,
    verification,
    learned: learnedView(params, variant),
    empty: true,
  };

  const latestModels = latest ? modelsOf(latest) : [];
  if (!latest || latestModels.length === 0) return base;

  const nowSec = Date.now() / 1000;
  const inputs = latestModels.map(toSeriesInput);
  // Gemessen (Referenz-Messstelle) vor Windguru-Schätzung.
  const waterTemp = water[0]?.value ?? latest.waterTemp;
  const consensus = buildConsensus(inputs, nowSec, params, { waterTemp });
  const gridTimes = consensus.points.map((p) => p.t);

  // Modelle nach Relevanz (Auflösung, dann Gewicht) für die Tiefen-Ansicht.
  const weightMap = new Map(consensus.contributors.map((c) => [c.idModel, c.weight]));
  const hourly = (m: DbModel) => {
    const h = modelHourly(toSeriesInput(m), gridTimes, params, { waterTemp });
    let last = -1;
    h.wind.forEach((v, i) => {
      if (v != null) last = i;
    });
    return { wind: h.wind, windAdj: h.windAdj, sigma: h.sigma, wh: h.w, coverEnd: last >= 0 ? gridTimes[last] : null };
  };
  const models: ModelView[] = latestModels
    .map((m) => {
      const info = modelInfo(m.idModel, m.resolution);
      const sk = skillById.get(m.idModel);
      return {
        idModel: m.idModel,
        label: info.label,
        longname: m.modelLongname,
        category: info.category,
        note: info.note,
        resolution: m.resolution,
        koef: m.koef,
        initStamp: m.initStamp,
        weight: weightMap.get(m.idModel) ?? 0,
        mae: sk?.mae ?? null,
        bias: sk?.bias ?? null,
        samples: sk?.samples ?? 0,
        ...hourly(m),
      };
    })
    // Wichtigstes zuerst: nach dem Gewicht in den nächsten 48 h — NICHT nach dem Anteil über
    // das ganze 16-Tage-Raster, bei dem Kurzfrist-Modelle (HARMONIE, ICON-D2 …) nur wegen
    // ihrer kurzen Reichweite hinten landeten.
    .sort((a, b) => sumWh(b.wh, 48) - sumWh(a.wh, 48) || b.weight - a.weight || (a.resolution ?? 99) - (b.resolution ?? 99));

  // Gewicht je Stunde (Vorlauf 0–24 h), wenn alle Modelle die Stunde abdecken — das ist die
  // Größe, die im Konsens tatsächlich wirkt.
  const hourW = new Map(skillRows.map((r) => [r.idModel, hourWeight(params, variant, r.idModel, r.resolution)]));
  const hourWSum = [...hourW.values()].reduce((a, b) => a + b, 0) || 1;

  // Güte-Ranking für die „Genauigkeit"-Ansicht (alle bewerteten Modelle, bestes zuerst).
  const skill: SkillView[] = skillRows
    .map((r) => ({
      idModel: r.idModel,
      // Anzeigename immer aus MODEL_INFO (spots.ts), nicht aus der DB-Zeile: der Lern-Job
      // kennt nur den Windguru-Rohnamen („ICON 7 km"), die Modell-Ansicht zeigt den
      // ausgeschriebenen („ICON-EU 7 km"). Sonst stehen in zwei Ansichten zwei Namen.
      label: modelInfo(r.idModel, r.resolution).label,
      category: modelInfo(r.idModel, r.resolution).category,
      resolution: r.resolution,
      mae: r.mae,
      bias: r.bias,
      samples: r.samples,
      weight: weightMap.get(r.idModel) ?? 0,
      hourShare: (hourW.get(r.idModel) ?? 0) / hourWSum,
      maeCorr: params?.models[String(r.idModel)]
        ? round1(0.8 * params.models[String(r.idModel)].fits[0][variant.mode].sigma)
        : null,
    }))
    .sort((a, b) => b.hourShare - a.hourShare || (a.mae ?? 99) - (b.mae ?? 99));

  // Frühere Datenstände: erst nur Zeitstempel (bis 8 Tage zurück), daraus die benötigten
  // Stände wählen und nur deren Modelle laden. (Bei 30-min-Takt reichen „die letzten N"
  // Snapshots nicht bis 3 T / 7 T zurück.)
  const histMeta = await prisma.snapshot.findMany({
    where: {
      spotId: spot.id,
      ok: true,
      runs: { some: {} },
      fetchedAt: { lt: latest.fetchedAt, gte: new Date(Date.now() - 8 * 86400e3) },
    },
    orderBy: { fetchedAt: "desc" },
    select: { id: true, fetchedAt: true },
  });

  // Trend-Läufe granular im 3–6-h-Raster wählen: dicht in den letzten ~2 Tagen, danach
  // weiter bis 7 Tage. So zeigt der Verlauf, wie sich die Vorhersage über die Zeit verändert.
  const TREND_AGES_H = [3, 6, 9, 12, 15, 18, 24, 30, 36, 48, 72, 96, 120, 168];
  const pickedMeta = pickByAges(histMeta, TREND_AGES_H);
  const cadMeta = CADENCES.map((c) => pickAround(histMeta, c.hours));
  const pastMeta = pickAround(histMeta, PAST_FORECAST_H);
  const needIds = [...new Set([...pickedMeta, ...cadMeta, pastMeta].filter(Boolean).map((m) => m!.id))];
  const histSnaps = needIds.length
    ? await prisma.snapshot.findMany({ where: { id: { in: needIds } }, include: WITH_RUNS })
    : [];
  const snapById = new Map(histSnaps.map((h) => [h.id, h]));
  const picked = pickedMeta.map((m) => snapById.get(m.id)!).filter(Boolean);

  const runs: TrendRun[] = picked.map((snap) => {
    const c = buildConsensus(modelsOf(snap).map(toSeriesInput), nowSec, params, { waterTemp: water[0]?.value ?? snap.waterTemp });
    const byTime = new Map(c.points.map((p) => [p.t, p.windspd]));
    return {
      fetchedAt: snap.fetchedAt.toISOString(),
      wind: gridTimes.map((t) => byTime.get(t) ?? null),
    };
  });

  // Prognose von vor ~24 h über die letzten Messstunden und weiter — damit der Verlauf
  // zeigt, wie gut die damalige Vorhersage die Messung traf.
  const pastSnap = pastMeta ? snapById.get(pastMeta.id) : undefined;
  const pastForecast = pastSnap ? buildPastForecast(pastSnap, stations, gridTimes, params, water[0]?.value ?? pastSnap.waterTemp) : null;

  // Vergleichs-Snapshots je Kadenz (3 h / 3 T / 7 T) und deren Tages-Spitzen.
  const cadencePeaks = CADENCES.map((c) => {
    const refMeta = cadMeta[CADENCES.indexOf(c)];
    const ref = refMeta ? snapById.get(refMeta.id) : undefined;
    return {
      ...c,
      peaks: ref
        ? dailyPeaks(buildConsensus(modelsOf(ref).map(toSeriesInput), nowSec, params, { waterTemp: water[0]?.value ?? ref.waterTemp }).points, lat, lon)
        : null,
    };
  });
  const curPeaks = dailyPeaks(consensus.points, lat, lon);

  const daily: DailyTrend[] = [...curPeaks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => {
      const deltas: TrendDelta[] = cadencePeaks.map((c) => {
        const prev = c.peaks?.get(day)?.peak ?? null;
        return {
          key: c.key,
          label: c.label,
          hours: c.hours,
          prev,
          delta: prev != null ? Math.round((v.peak - prev) * 10) / 10 : null,
        };
      });
      const sun = sunTimes(lat, lon, day);
      return {
        day,
        label: dayLabel(v.at),
        peak: v.peak,
        peakGust: v.gust,
        dir: v.dir,
        deltas,
        sunrise: sun.rise,
        sunset: sun.set,
      };
    });

  const np = nowPoint(consensus.points);

  return {
    ...base,
    empty: false,
    fetchedAt: latest.fetchedAt.toISOString(),
    sunrise: latest.sunrise,
    sunset: latest.sunset,
    waterTemp: latest.waterTemp,
    timezone: latest.timezone,
    now: np,
    nowcast: buildNowcast(stations, consensus.points, params?.nowcastGain),
    points: consensus.points,
    gridTimes,
    models,
    skill,
    contributors: consensus.contributors,
    trend: { runs, daily, refFetchedAt: picked.at(-1)?.fetchedAt.toISOString() ?? null },
    pastForecast,
  };
}

const sumWh = (wh: (number | null)[], n: number) => wh.slice(0, n).reduce<number>((a, w) => a + (w ?? 0), 0);

/** Konsens-Gewicht eines Modells je Stunde bei Vorlauf 0–24 h (wie modelHour in calib.ts). */
function hourWeight(params: SpotParams | null, variant: Variant, idModel: number, res: number | null): number {
  if (variant.weights === "equal") return 1;
  const fit = params?.models[String(idModel)]?.fits[0]?.[variant.mode];
  const sigma = Math.max(0.8, fit?.sigma ?? priorSigma(res, 0));
  return 1 / (sigma * sigma);
}

/** Gelerntes Nachkorrektur-Modell in lesbarer Form (je Modell × Vorlauf-Stufe). */
function learnedView(params: SpotParams | null, variant: Variant): LearnedView | null {
  if (!params?.models) return null;
  const mode = variant.mode;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const models = Object.entries(params.models).map(([id, m]) => {
    const idModel = Number(id);
    const info = modelInfo(idModel, m.resolution);
    const fits = Array.from({ length: LEAD_BUCKETS }, (_, b) => m.fits[b]?.[mode]);
    const beta = (b: number, k: number) => fits[b]?.beta[k] ?? 0;
    return {
      idModel,
      label: info.label,
      category: info.category,
      resolution: m.resolution,
      n: Array.from({ length: LEAD_BUCKETS }, (_, b) => m.n[b] ?? 0),
      sigma: fits.map((f, b) => r2(f?.sigma ?? priorSigma(m.resolution, b))),
      // Merkmale wie features() in calib.ts: 0 = Achsenabschnitt, 1–4 = Quadrant N/O/S/W.
      shift: fits.map((_, b) => [0, 1, 2, 3].map((q) => (mode === "raw" ? 0 : r2(beta(b, 0) + beta(b, 1 + q))))),
      slope: mode === "lin" || mode === "linT" ? fits.map((_, b) => r2(beta(b, 5))) : null,
      temp: mode === "linT" ? fits.map((_, b) => r2(beta(b, 6))) : null,
    };
  });
  models.sort((a, b) => a.sigma[0] - b.sigma[0]);
  return { mode, leadLabels: LEAD_LABELS, maxCorrKn: MAX_CORR_KN, models };
}

/**
 * Konsens eines früheren Datenstands auf dem Gitter „ab seinem Abrufzeitpunkt bis Ende der
 * aktuellen Prognose", plus seine Abweichung von der Messung in den bereits vergangenen
 * Stunden (Stundenmittel der ersten Station mit Daten).
 */
function buildPastForecast(
  snap: { fetchedAt: Date } & SnapRuns,
  stations: StationView[],
  gridTimes: number[],
  params: SpotParams | null,
  waterTemp: number | null,
): PastForecast | null {
  const F = Math.floor(snap.fetchedAt.getTime() / 1000);
  const start = hourTs(F) + 3600;
  const end = gridTimes.at(-1) ?? start;
  const grid: number[] = [];
  for (let t = start; t <= end; t += 3600) grid.push(t);
  const c = buildConsensus(modelsOf(snap).map(toSeriesInput), F, params, { grid, waterTemp });
  if (!c.points.length) return null;

  const st = stations.find((x) => x.series.length);
  const hourly = new Map<number, { sum: number; n: number }>();
  for (const o of st?.series ?? []) {
    if (o.windAvg == null) continue;
    const k = hourTs(o.t);
    const h = hourly.get(k);
    if (h) {
      h.sum += o.windAvg;
      h.n += 1;
    } else hourly.set(k, { sum: o.windAvg, n: 1 });
  }
  let abs = 0;
  let err = 0;
  let n = 0;
  for (const p of c.points) {
    const m = hourly.get(p.t);
    if (!m || p.windspd == null || p.t > Date.now() / 1000) continue;
    const e = p.windspd - m.sum / m.n;
    abs += Math.abs(e);
    err += e;
    n += 1;
  }
  return {
    fetchedAt: snap.fetchedAt.toISOString(),
    points: c.points.map((p) => ({ t: p.t, wind: p.windspd, gust: p.gust })),
    mae: n ? round1(abs / n) : null,
    bias: n ? round1(err / n) : null,
    n,
  };
}

/**
 * Wählt für jedes Zielalter (Stunden) den passendsten Snapshot — sofern es einen gibt, der
 * nah genug dran liegt (Toleranz = halber Abstand zum Nachbarziel, min. 2 h). Ergebnis ist
 * nach Alter aufsteigend (neu → alt), dedupliziert.
 */
function pickByAges<T extends { fetchedAt: Date }>(arr: T[], agesH: number[]): T[] {
  if (!arr.length) return [];
  const now = Date.now();
  const seen = new Set<T>();
  const out: T[] = [];
  agesH.forEach((age, i) => {
    const target = now - age * 3600 * 1000;
    const neighbourGap = i + 1 < agesH.length ? agesH[i + 1] - age : age - agesH[i - 1];
    const tolMs = Math.max(2, neighbourGap / 2) * 3600 * 1000;
    let best: T | null = null;
    let bestD = Infinity;
    for (const s of arr) {
      const d = Math.abs(s.fetchedAt.getTime() - target);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best && bestD <= tolMs && !seen.has(best)) {
      seen.add(best);
      out.push(best);
    }
  });
  return out;
}

/**
 * Snapshot, dessen Alter am nächsten an `hours` Stunden liegt — aber nur, wenn er innerhalb
 * der Toleranz liegt (sonst null: es gibt noch keinen passend alten Datenstand).
 */
function pickAround<T extends { fetchedAt: Date }>(arr: T[], hours: number): T | null {
  if (!arr.length) return null;
  const target = Date.now() - hours * 3600 * 1000;
  const tolMs = Math.max(2, hours * 0.5) * 3600 * 1000;
  let best: T | null = null;
  let bestD = Infinity;
  for (const s of arr) {
    const d = Math.abs(s.fetchedAt.getTime() - target);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best && bestD <= tolMs ? best : null;
}

/**
 * Modell-Check für einen Spot & Tag: die Vorhersage jedes Modells aus einem festen
 * Prognose-Stand (dem letzten Lauf vor Tagesbeginn = „day-ahead") gegen den gemessenen Wind
 * dieses Tages, plus MAE je Modell (welches Modell traf am besten). Blätterbar über `days`.
 */
async function buildModelVerification(
  spotId: number,
  day?: string,
): Promise<ModelVerification | null> {
  const winStart = new Date(Date.now() - VERIF_WINDOW_DAYS * 24 * 3600 * 1000);
  const spotStat = await prisma.spotStat.findUnique({ where: { spotId }, select: { params: true } });
  const params = (spotStat?.params ?? null) as unknown as SpotParams | null;
  const obs = await prisma.stationObs.findMany({
    where: {
      spotId,
      stationId: { in: spotStationIds(spotId) },
      obsTime: { gte: winStart },
      windAvg: { not: null },
    },
    select: { obsTime: true, windAvg: true },
  });
  if (!obs.length) return null;

  // Messung je Stunde (Mittel über Stationen/Sub-Stunden) + Tage mit Messungen.
  const measuredHour = new Map<number, { sum: number; n: number }>();
  const daysMap = new Map<string, number>();
  for (const o of obs) {
    if (o.windAvg == null) continue;
    const sec = Math.floor(o.obsTime.getTime() / 1000);
    const hk = hourTs(sec);
    const m = measuredHour.get(hk);
    if (m) {
      m.sum += o.windAvg;
      m.n += 1;
    } else measuredHour.set(hk, { sum: o.windAvg, n: 1 });
    const dk = dayKey(sec);
    if (!daysMap.has(dk)) daysMap.set(dk, sec);
  }
  const days = [...daysMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, sec]) => ({ day: d, label: dayLabel(sec) }));
  const sel = day && daysMap.has(day) ? day : days[days.length - 1].day;

  const gridTimes = [...measuredHour.keys()].filter((h) => dayKey(h) === sel).sort((a, b) => a - b);
  const measured = gridTimes.map((h) => {
    const m = measuredHour.get(h)!;
    return round1(m.sum / m.n);
  });

  const empty: ModelVerification = {
    days,
    day: sel,
    refFetchedAt: null,
    gridTimes,
    measured,
    consensus: gridTimes.map(() => null),
    models: [],
  };
  if (!gridTimes.length) return empty;

  // Prognose-Stand: letzter Lauf vor Tagesbeginn (day-ahead); sonst der früheste Lauf.
  const dayStart = new Date(gridTimes[0] * 1000);
  const ref =
    (await prisma.snapshot.findFirst({
      where: { spotId, ok: true, runs: { some: {} }, fetchedAt: { lte: dayStart } },
      orderBy: { fetchedAt: "desc" },
      include: WITH_RUNS,
    })) ??
    (await prisma.snapshot.findFirst({
      where: { spotId, ok: true, runs: { some: {} } },
      orderBy: { fetchedAt: "asc" },
      include: WITH_RUNS,
    }));
  const refModels = ref ? modelsOf(ref) : [];
  if (!ref || refModels.length === 0) return empty;

  const cons = buildConsensus(
    refModels.map(toSeriesInput),
    Math.floor(ref.fetchedAt.getTime() / 1000),
    params,
    { waterTemp: ref.waterTemp },
  );
  const consMap = new Map(cons.points.map((p) => [p.t, p.windspd]));
  const consensus = gridTimes.map((t) => consMap.get(t) ?? null);
  const weightMap = new Map(cons.contributors.map((c) => [c.idModel, c.weight]));

  const models = refModels
    .map((m) => {
      const info = modelInfo(m.idModel, m.resolution);
      const wind = modelOnGrid(toSeriesInput(m), gridTimes);
      let sumAbs = 0;
      let n = 0;
      wind.forEach((w, i) => {
        const meas = measured[i];
        if (w != null && meas != null) {
          sumAbs += Math.abs(w - meas);
          n += 1;
        }
      });
      return {
        idModel: m.idModel,
        label: info.label,
        resolution: m.resolution,
        weight: weightMap.get(m.idModel) ?? 0,
        wind,
        mae: n ? round1(sumAbs / n) : null,
      };
    })
    // Bestes Modell (kleinster MAE an diesem Tag) zuerst.
    .sort((a, b) => (a.mae ?? 999) - (b.mae ?? 999));

  return { days, day: sel, refFetchedAt: ref.fetchedAt.toISOString(), gridTimes, measured, consensus, models };
}

export async function loadModelVerification(
  spotId: number,
  day?: string,
): Promise<ModelVerification | null> {
  await ensureHostResolved();
  return buildModelVerification(spotId, day);
}

// Die Ansicht ändert sich nur mit einem neuen Abruf, Lernlauf oder Messwert (alle ≥ 30 min)
// — also nicht bei jedem Aufruf alle Konsense neu rechnen. Der Schlüssel fasst die jüngsten
// Zeitstempel der Jobs und die aktuelle Stunde zusammen (das Raster beginnt „jetzt"); die
// Höchstdauer hält Altersangaben („vor N min") frisch. Je Server-Instanz, bewusst schlicht.
const VIEW_TTL_MS = 10 * 60 * 1000;
let viewCache: { key: string; at: number; data: Promise<SpotPayload[]> } | null = null;

async function viewKey(): Promise<string> {
  const [snap, stat, obs, water] = await Promise.all([
    prisma.snapshot.aggregate({ _max: { fetchedAt: true } }),
    prisma.spotStat.aggregate({ _max: { updatedAt: true } }),
    prisma.stationObs.aggregate({ _max: { obsTime: true } }),
    prisma.waterTemp.aggregate({ _max: { obsTime: true } }),
  ]);
  const t = (d: Date | null | undefined) => d?.getTime() ?? 0;
  return [t(snap._max.fetchedAt), t(stat._max.updatedAt), t(obs._max.obsTime), t(water._max.obsTime), hourTs(Date.now() / 1000)].join("|");
}

export async function loadDashboard(): Promise<SpotPayload[]> {
  await ensureHostResolved();
  const key = await viewKey();
  if (viewCache && viewCache.key === key && Date.now() - viewCache.at < VIEW_TTL_MS) return viewCache.data;
  const data = prisma.spot
    .findMany({ orderBy: { sortOrder: "asc" } })
    .then((spots) => Promise.all(spots.map(buildSpotPayload)));
  viewCache = { key, at: Date.now(), data };
  // Ein Fehler darf nicht für die ganze Höchstdauer hängen bleiben.
  data.catch(() => {
    if (viewCache?.data === data) viewCache = null;
  });
  return data;
}

export async function loadStatus() {
  await ensureHostResolved();
  const spots = await prisma.spot.findMany({ orderBy: { sortOrder: "asc" } });
  const rows = await Promise.all(
    spots.map(async (s) => {
      const count = await prisma.snapshot.count({ where: { spotId: s.id } });
      const last = await prisma.snapshot.findFirst({
        where: { spotId: s.id, ok: true },
        orderBy: { fetchedAt: "desc" },
        select: { fetchedAt: true },
      });
      const stat = await prisma.spotStat.findUnique({
        where: { spotId: s.id },
        select: { updatedAt: true },
      });
      // Alter je Messstation: eine stumme Station ist der gefährlichste stille Fehler —
      // die Prognose läuft weiter, aber alles Gelernte altert unbemerkt ein.
      const stations = await Promise.all(
        spotStationIds(s.id).map(async (stationId) => {
          const obs = await prisma.stationObs.findFirst({
            where: { spotId: s.id, stationId },
            orderBy: { obsTime: "desc" },
            select: { obsTime: true },
          });
          return { stationId, lastObs: obs?.obsTime.toISOString() ?? null };
        }),
      );
      return {
        id: s.id,
        name: s.name,
        snapshots: count,
        lastFetch: last?.fetchedAt.toISOString() ?? null,
        // Wann hat der Lern-Job (scripts/skill_job.py) hier zuletzt gerechnet?
        lastLearned: stat?.updatedAt.toISOString() ?? null,
        stations,
      };
    }),
  );
  return {
    // Erfassung und Lernen laufen als Databricks-Jobs, nicht in dieser App — deshalb steht
    // hier kein Poller-Zustand mehr, sondern das Alter dessen, was die Jobs geliefert haben.
    writes: "databricks-jobs",
    spots: rows,
  };
}
