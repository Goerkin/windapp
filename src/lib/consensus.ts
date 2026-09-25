// Eigener Modell-Konsens: je Stunde ein gewichtetes Mittel über alle Modelle, die die Stunde
// abdecken — jedes Modell vorher statistisch nachkorrigiert und nach seinem Restfehler
// gewichtet, beides je Vorlauf-Stufe (siehe calib.ts; gelernt in skill.ts). Ohne Parameter
// (keine Historie) greift der auflösungsbasierte Prior: roh, feiner = höheres Gewicht.
// Zusätzlich Streuung (Min/Max + Std) und optional P(≥ Schwelle) per Ensemble-Dressing.

import { modelHour, mixtureProb, variantOf, type SpotParams, type Variant } from "./calib";

export type SeriesInput = {
  idModel: number;
  modelName: string;
  resolution?: number | null;
  koef: number;
  initStamp: number;
  series: {
    times: number[];
    WINDSPD?: (number | null)[];
    GUST?: (number | null)[];
    WINDDIR?: (number | null)[];
    TMP?: (number | null)[];
    TCDC?: (number | null)[];
    HCDC?: (number | null)[];
    MCDC?: (number | null)[];
    LCDC?: (number | null)[];
    APCP1?: (number | null)[];
    RH?: (number | null)[];
    SLP?: (number | null)[];
  };
};

export type ConsensusPoint = {
  t: number; // Unix-Sekunden
  windspd: number | null;
  gust: number | null;
  winddir: number | null;
  tmp: number | null;
  cloud: number | null;
  cloudLow: number | null;
  cloudMid: number | null;
  cloudHigh: number | null;
  precip: number | null;
  rh: number | null;
  windMin: number | null; // Modell-Minimum
  windMax: number | null; // Modell-Maximum
  windSd: number | null; // gewichtete Standardabweichung
  n: number; // Anzahl beitragender Modelle
  pAbove?: number | null; // P(Wind ≥ opts.probAt), nur wenn angefragt
  pFrac?: number | null; // gewichteter Anteil der Modelle ≥ opts.probAt (Vergleichsmaß)
};

export type Consensus = {
  points: ConsensusPoint[];
  contributors: { idModel: number; modelName: string; weight: number }[];
};

export type ConsensusOpts = {
  grid?: number[]; // feste Zeitpunkte statt „ab jetzt stündlich"
  variant?: string; // Varianten-Schlüssel (sonst die in params gewählte)
  waterTemp?: number | null; // Wassertemperatur für den Schichtungs-Term
  probAt?: number; // Schwelle (kn) für pAbove/pFrac
};

export const HORIZON_H = 384; // 16 Tage (GFS reicht so weit, ECMWF 15 T — danach nur noch global)

/** Eine Modell-Stunde: roh interpoliert + korrigiert + Gewicht + Restfehler. */
type Contrib = { raw: number; wind: number; shift: number; w: number; sigma: number; dir: number | null };

function contribAt(
  m: SeriesInput,
  t: number,
  params: SpotParams | null | undefined,
  variant: Variant,
  waterTemp: number | null | undefined,
): Contrib | null {
  const times = m.series.times;
  if (!times?.length || t < times[0] || t > times[times.length - 1]) return null;
  const raw = lerpAt(times, m.series.WINDSPD, t);
  if (raw == null) return null;
  const dir = lerpDir(times, m.series.WINDDIR, t);
  const tmp = lerpAt(times, m.series.TMP, t);
  const dT = waterTemp != null && tmp != null ? waterTemp - tmp : null;
  const leadH = (t - m.initStamp) / 3600;
  const h = modelHour(params, variant, m.idModel, m.resolution, leadH, raw, dir, dT);
  return { raw, wind: h.wind, shift: h.shift, w: h.w, sigma: h.sigma, dir };
}

/**
 * Stundenreihen eines Modells auf dem Gitter: roh, korrigiert, Restfehler σ und Gewicht —
 * für die Modell-Ansicht und die Wahrscheinlichkeit im Client.
 */
export function modelHourly(
  m: SeriesInput,
  grid: number[],
  params: SpotParams | null | undefined,
  opts: { variant?: string; waterTemp?: number | null } = {},
): { wind: (number | null)[]; windAdj: (number | null)[]; sigma: (number | null)[]; w: (number | null)[] } {
  const variant = variantOf(opts.variant ?? params?.variant);
  const out = { wind: [] as (number | null)[], windAdj: [] as (number | null)[], sigma: [] as (number | null)[], w: [] as (number | null)[] };
  for (const t of grid) {
    const c = contribAt(m, t, params, variant, opts.waterTemp);
    out.wind.push(c ? round(c.raw) : null);
    out.windAdj.push(c ? round(c.wind) : null);
    out.sigma.push(c ? round(c.sigma, 2) : null);
    out.w.push(c ? c.w : null);
  }
  return out;
}

function round(v: number | null, d = 1): number | null {
  if (v == null || Number.isNaN(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// Wettergrößen neben dem Wind: Feld im Konsens-Punkt, Reihe bei Windguru, Nachkommastellen.
// Jede Größe wird nur über die Modelle gemittelt, die sie auch liefern — im Nenner steht deren
// Gewicht, nicht das aller Modelle. Sonst zieht jedes Modell ohne die Reihe den Wert Richtung 0.
const WX = [
  ["tmp", "TMP", 1],
  ["cloud", "TCDC", 0],
  ["cloudLow", "LCDC", 0],
  ["cloudMid", "MCDC", 0],
  ["cloudHigh", "HCDC", 0],
  ["precip", "APCP1", 2],
  ["rh", "RH", 0],
] as const;

export function buildConsensus(
  models: SeriesInput[],
  nowSec = Date.now() / 1000,
  params?: SpotParams | null,
  opts: ConsensusOpts = {},
): Consensus {
  const usable = models.filter((m) => m.series?.times?.length);
  const variant = variantOf(opts.variant ?? params?.variant);
  if (!usable.length) return { points: [], contributors: [] };

  // Gitter: von aktueller Stunde bis Horizont bzw. Ende der Datenabdeckung — oder fest.
  let grid = opts.grid;
  if (!grid) {
    const gridStart = Math.floor(nowSec / 3600) * 3600;
    const maxCover = Math.max(...usable.map((m) => m.series.times[m.series.times.length - 1]));
    const gridEnd = Math.min(gridStart + HORIZON_H * 3600, maxCover);
    grid = [];
    for (let t = gridStart; t <= gridEnd; t += 3600) grid.push(t);
  }

  const wTotals = new Map<number, number>();
  const points: ConsensusPoint[] = [];
  for (const t of grid) {
    let wSum = 0;
    let windAcc = 0;
    let gustAcc = 0;
    const wxAcc = WX.map(() => 0);
    const wxW = WX.map(() => 0);
    let dirX = 0;
    let dirY = 0;
    let n = 0;
    let windMin = Infinity;
    let windMax = -Infinity;
    const samples: { v: number; w: number; sigma: number }[] = [];

    for (const m of usable) {
      const c = contribAt(m, t, params, variant, opts.waterTemp);
      if (!c) continue;
      const times = m.series.times;
      const { w, wind } = c;
      n++;
      wSum += w;
      windAcc += w * wind;
      samples.push({ v: wind, w, sigma: c.sigma });
      wTotals.set(m.idModel, (wTotals.get(m.idModel) ?? 0) + w);
      if (wind < windMin) windMin = wind;
      if (wind > windMax) windMax = wind;

      const gust = lerpAt(times, m.series.GUST, t);
      // Böen um dieselbe Korrektur verschieben; fehlt GUST, grob 1.25 × Wind schätzen.
      gustAcc += w * (gust != null ? Math.max(wind, gust - c.shift) : wind * 1.25);
      WX.forEach(([, key], k) => {
        const v = lerpAt(times, m.series[key], t);
        if (v == null) return;
        wxAcc[k] += w * v;
        wxW[k] += w;
      });

      if (c.dir != null) {
        dirX += w * Math.cos((c.dir * Math.PI) / 180);
        dirY += w * Math.sin((c.dir * Math.PI) / 180);
      }
    }

    if (n === 0 || wSum === 0) continue;

    const windMean = windAcc / wSum;
    let variance = 0;
    for (const s of samples) variance += s.w * (s.v - windMean) ** 2;
    const sd = Math.sqrt(variance / wSum);

    let dir: number | null = null;
    if (dirX !== 0 || dirY !== 0) {
      dir = (Math.atan2(dirY, dirX) * 180) / Math.PI;
      if (dir < 0) dir += 360;
    }

    const wx = Object.fromEntries(
      WX.map(([name, , digits], k) => [name, wxW[k] > 0 ? round(wxAcc[k] / wxW[k], digits) : null]),
    ) as Record<(typeof WX)[number][0], number | null>;

    const pt: ConsensusPoint = {
      t,
      windspd: round(windMean),
      gust: round(gustAcc / wSum),
      winddir: dir == null ? null : Math.round(dir),
      ...wx,
      windMin: round(windMin === Infinity ? null : windMin),
      windMax: round(windMax === -Infinity ? null : windMax),
      windSd: round(sd),
      n,
    };
    if (opts.probAt != null) {
      pt.pAbove = mixtureProb(samples, opts.probAt);
      pt.pFrac = samples.reduce((a, s) => a + (s.v >= opts.probAt! ? s.w : 0), 0) / wSum;
    }
    points.push(pt);
  }

  // Anteil je Modell = Summe seiner Stundengewichte / Summe aller (über das Gitter).
  const total = [...wTotals.values()].reduce((a, b) => a + b, 0) || 1;
  const contributors = usable
    .map((m) => ({ idModel: m.idModel, modelName: m.modelName, weight: (wTotals.get(m.idModel) ?? 0) / total }))
    .sort((a, b) => b.weight - a.weight);

  return { points, contributors };
}

/** Wind (WINDSPD) eines einzelnen Modells auf das Gitter interpoliert (roh). */
export function modelOnGrid(m: SeriesInput, gridTimes: number[]): (number | null)[] {
  return gridTimes.map((t) => {
    const times = m.series.times;
    if (!times?.length || t < times[0] || t > times[times.length - 1]) return null;
    return round(lerpAt(times, m.series.WINDSPD, t));
  });
}

/** Richtung/Temperatur eines Modells auf dem Gitter (für die Fehler-Stichproben). */
export function modelAt(m: SeriesInput, t: number): { wind: number | null; dir: number | null; tmp: number | null } {
  const times = m.series.times;
  if (!times?.length || t < times[0] || t > times[times.length - 1]) return { wind: null, dir: null, tmp: null };
  return {
    wind: lerpAt(times, m.series.WINDSPD, t),
    dir: lerpDir(times, m.series.WINDDIR, t),
    tmp: lerpAt(times, m.series.TMP, t),
  };
}

/** Lineare Interpolation eines Skalars auf Zeitpunkt t (nulls werden übersprungen). */
function lerpAt(times: number[], vals: (number | null)[] | undefined, t: number): number | null {
  if (!vals) return null;
  // Nur gültige Stützstellen.
  let loI = -1;
  let hiI = -1;
  for (let i = 0; i < times.length; i++) {
    if (vals[i] == null) continue;
    if (times[i] <= t) loI = i;
    if (times[i] >= t) {
      hiI = i;
      break;
    }
  }
  if (loI === -1 && hiI === -1) return null;
  if (loI === -1) return vals[hiI] as number;
  if (hiI === -1) return vals[loI] as number;
  if (loI === hiI) return vals[loI] as number;
  const t0 = times[loI];
  const t1 = times[hiI];
  const v0 = vals[loI] as number;
  const v1 = vals[hiI] as number;
  if (t1 === t0) return v0;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/** Zirkuläre Interpolation einer Richtung (Grad). */
function lerpDir(times: number[], vals: (number | null)[] | undefined, t: number): number | null {
  if (!vals) return null;
  let loI = -1;
  let hiI = -1;
  for (let i = 0; i < times.length; i++) {
    if (vals[i] == null) continue;
    if (times[i] <= t) loI = i;
    if (times[i] >= t) {
      hiI = i;
      break;
    }
  }
  if (loI === -1 && hiI === -1) return null;
  if (loI === -1) return vals[hiI] as number;
  if (hiI === -1) return vals[loI] as number;
  if (loI === hiI) return vals[loI] as number;
  const frac = (t - times[loI]) / (times[hiI] - times[loI]);
  const a = ((vals[loI] as number) * Math.PI) / 180;
  const b = ((vals[hiI] as number) * Math.PI) / 180;
  const x = Math.cos(a) * (1 - frac) + Math.cos(b) * frac;
  const y = Math.sin(a) * (1 - frac) + Math.sin(b) * frac;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

