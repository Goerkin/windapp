// Parity-Test: rechnen Lern-Job (scripts/skill_job.py) und App (src/lib/calib.ts +
// consensus.ts) dieselbe Mathematik? Beide bekommen identische Eingaben — reproduzierbar
// zufällige Modellläufe mit gezielten Grenzfällen — und müssen Stunde für Stunde dasselbe
// liefern. Kein DB-Zugriff, keine gespeicherten Sollwerte: die eine Seite ist das Soll der
// anderen. Schlägt er fehl, ist eine Formel nur auf einer Seite geändert worden.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VARIANTS,
  LEAD_BUCKETS,
  MODES,
  N_FEAT,
  features,
  leadBucket,
  modelHour,
  normCdf,
  priorSigma,
  quadrant,
  variantOf,
  type Mode,
  type ModeFit,
  type SpotParams,
} from "../../src/lib/calib";
import { buildConsensus, modelAt, type SeriesInput } from "../../src/lib/consensus";

// ── Eingaben ─────────────────────────────────────────────────────────────────────────────

/** mulberry32 — kleiner, reproduzierbarer PRNG (gleicher Seed ⇒ gleiche Eingaben). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const H = 3600;
const BASE = 1_760_000_400 - (1_760_000_400 % H); // volle Stunde

type Run = SeriesInput & { series: { times: number[]; WINDSPD?: (number | null)[]; WINDDIR?: (number | null)[]; TMP?: (number | null)[] } };

function makeRuns(rand: () => number): Run[] {
  // [idModel, Auflösung, Schritt (h), Länge (h), Vorlauf des Init (h), Besonderheit]
  const specs: [number, number | null, number, number, number, string][] = [
    [48, 2, 1, 60, 0, "genau auf Bucket-Grenzen (Init = BASE)"],
    [52, 1.3, 1, 48, 5, ""],
    [117, 9, 3, 150, 12, "3-h-Schritte ⇒ Interpolation"],
    [3, 13, 3, 200, 18, "ohne TMP"],
    [44, 2.2, 1, 30, 2, "ohne WINDDIR, endet früh"],
    [999, null, 6, 120, 0, "unbekanntes Modell ohne Auflösung, ohne Parameter"],
  ];
  return specs.map(([idModel, resolution, step, len, initAgo, note]) => {
    const times: number[] = [];
    for (let h = 0; h <= len; h += step) times.push(BASE + h * H);
    const n = times.length;
    const wind = times.map(() => (rand() < 0.08 ? null : Math.round(rand() * 32 * 10) / 10));
    // Richtungen inkl. Fallen: genau 225° (np.round vs Math.round), Wrap 350↔10.
    const dir = times.map((_, i) =>
      rand() < 0.06 ? null : i % 7 === 0 ? 225 : i % 11 === 0 ? (i % 2 ? 350 : 10) : Math.round(rand() * 3600) / 10,
    );
    const tmp = times.map(() => (rand() < 0.05 ? null : Math.round((8 + rand() * 14) * 10) / 10));
    const series: Run["series"] = { times, WINDSPD: wind };
    if (!note.includes("ohne WINDDIR")) series.WINDDIR = dir;
    if (!note.includes("ohne TMP")) series.TMP = tmp;
    if (n > 3) wind[0] = null; // null am Rand ⇒ Klemmen an der ersten GÜLTIGEN Stützstelle
    return { idModel, modelName: `M${idModel}`, resolution, koef: 1, initStamp: BASE - initAgo * H, series };
  });
}

function makeParams(rand: () => number, runs: Run[]): SpotParams {
  const models: SpotParams["models"] = {};
  for (const r of runs) {
    if (r.idModel === 999) continue; // ⇒ Prior-Fallback
    // Modell 3 hat nur 2 Stufen ⇒ ab 48 h Prior-Fallback (IndexError / undefined).
    const nb = r.idModel === 3 ? 2 : LEAD_BUCKETS;
    const fits = [] as Record<Mode, ModeFit>[];
    for (let b = 0; b < nb; b++) {
      const perMode = {} as Record<Mode, ModeFit>;
      for (const mode of MODES) {
        // Große Betas erreichen die Kappung MAX_CORR_KN, kleine σ die Untergrenze 0.8.
        const beta = Array.from({ length: N_FEAT }, (_, k) => (rand() - 0.5) * (k === 0 ? 10 : k === 5 ? 0.6 : 3));
        perMode[mode] = { beta, sigma: rand() < 0.15 ? 0.3 : 1 + rand() * 4 };
      }
      fits.push(perMode);
    }
    models[String(r.idModel)] = { resolution: r.resolution ?? null, n: [], fits };
  }
  return { variant: "lin_skill", models, sigmaScale: 1.3, nowcastGain: [], fittedAt: BASE };
}

const rand = rng(20260924);
const runs = makeRuns(rand);
const params = makeParams(rand, runs);
// Stündliches Gitter; beginnt VOR allen Läufen und endet NACH den meisten.
const grid: number[] = [];
for (let h = -20; h <= 210; h++) grid.push(BASE + h * H);
const PROB_AT = 13; // TH.min in kite.ts / TH_MIN in skill_job.py

const cases = VARIANTS.flatMap((v) =>
  [params, null].flatMap((p) => [14.5, null].map((waterTemp) => ({ variant: v.key, params: p, waterTemp, grid, probAt: PROB_AT }))),
);

const scalars = {
  leadH: [-1, 0, 23.99, 24, 47.5, 48, 71.99, 72, 200],
  dirs: [0, 44.99, 45, 135, 225, 315, 359.99, 360, -45, 719.99, 180],
  res: [null, 0, 1.3, 2, 9, 13, 40],
  z: [-6, -1.5, 0, 0.3, 2, 6],
  features: [[10, 225, 3], [0, null, null], [25.5, 44, -2]] as [number, number | null, number | null][],
};

// ── Python-Seite ─────────────────────────────────────────────────────────────────────────

type PyPoint = { wind: number; samples: [number, number, number][]; pAbove: number | null; pFrac: number | null };
type PyOut = {
  cases: Record<string, PyPoint>[];
  leadBucket: number[];
  quadrant: number[];
  priorSigma: number[][];
  normCdf: number[];
  features: number[][];
};

const py: PyOut = JSON.parse(
  execFileSync(process.env.PYTHON ?? "python3", [fileURLToPath(new URL("./py_bridge.py", import.meta.url))], {
    input: JSON.stringify({ runs, cases, scalars }),
    maxBuffer: 256 * 1024 * 1024,
  }).toString(),
);

// ── Vergleich ────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;
// buildConsensus rundet Wind auf 0.1 kn — Python rechnet ungerundet.
const ROUND_TOL = 0.05 + EPS;

describe("Hilfsfunktionen: Python = TypeScript", () => {
  it("leadBucket", () => expect(scalars.leadH.map(leadBucket)).toEqual(py.leadBucket));
  it("quadrant (inkl. genau 225°)", () => expect(scalars.dirs.map(quadrant)).toEqual(py.quadrant));
  it("priorSigma", () => {
    scalars.res.forEach((r, i) =>
      py.priorSigma[i].forEach((s, b) => expect(priorSigma(r, b)).toBeCloseTo(s, 12)),
    );
  });
  it("normCdf", () => scalars.z.forEach((z, i) => expect(normCdf(z)).toBeCloseTo(py.normCdf[i], 12)));
  it("features", () => {
    scalars.features.forEach(([fc, dir, dT], i) => expect(features(fc, dir, dT)).toEqual(py.features[i]));
  });
});

describe("Konsens: Python (Lern-Job) = TypeScript (App)", () => {
  cases.forEach((c, ci) => {
    const label = `${c.variant} · ${c.params ? "gelernt" : "Prior"} · Wasser ${c.waterTemp ?? "–"}`;
    it(label, () => {
      const pyPts = py.cases[ci];
      const ts = buildConsensus(runs, 0, c.params, { grid: c.grid, variant: c.variant, waterTemp: c.waterTemp, probAt: c.probAt });
      const variant = variantOf(c.variant);
      const scale = c.params?.sigmaScale ?? 1;

      // Dieselben Stunden abgedeckt.
      expect(ts.points.map((p) => String(p.t))).toEqual(Object.keys(pyPts));
      expect(ts.points.length).toBeGreaterThan(100);

      for (const p of ts.points) {
        const q = pyPts[String(p.t)];
        const at = `t=${(p.t - BASE) / H} h`;

        // Einzelbeiträge je Modell, ungerundet — hier fallen Formelabweichungen zuerst auf.
        const tsSamples = runs.flatMap((m) => {
          const { wind, dir, tmp } = modelAt(m, p.t);
          if (wind == null) return [];
          const dT = c.waterTemp != null && tmp != null ? c.waterTemp - tmp : null;
          const h = modelHour(c.params, variant, m.idModel, m.resolution, (p.t - m.initStamp) / H, wind, dir, dT);
          return [[h.wind, h.w, h.sigma]];
        });
        expect(tsSamples.length, at).toBe(q.samples.length);
        expect(p.n, at).toBe(q.samples.length);
        tsSamples.forEach(([v, w, s], i) => {
          const [pv, pw, ps] = q.samples[i];
          expect(Math.abs(v - pv), `${at} Modell ${i} Wind`).toBeLessThan(EPS);
          expect(Math.abs(w - pw), `${at} Modell ${i} Gewicht`).toBeLessThan(EPS);
          expect(Math.abs(s - ps * scale), `${at} Modell ${i} σ`).toBeLessThan(EPS);
        });

        expect(Math.abs(p.windspd! - q.wind), `${at} Konsens-Wind`).toBeLessThan(ROUND_TOL);
        expect(Math.abs(p.pAbove! - q.pAbove!), `${at} P(≥${PROB_AT})`).toBeLessThan(EPS);
        expect(Math.abs(p.pFrac! - q.pFrac!), `${at} Anteil ≥${PROB_AT}`).toBeLessThan(EPS);
      }
    });
  });
});
