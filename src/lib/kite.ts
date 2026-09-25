// Kite-Logik (framework-neutral, läuft im Client): feste Wind-Schwellen (Twintip, 80 kg),
// Richtungs-Eignung des Spots, Wahrscheinlichkeit P(≥ Mindestwind) aus den Modellen und
// daraus die fahrbaren Zeitfenster je Tag — die Hauptaussage der Tageskarten.

import type { DirSectors, SpotPayload, Nowcast } from "./types";
import { topKMean } from "./units";
import { mixtureProb } from "./calib";

/**
 * Wind-Schwellen in kn — feste Referenz: Twintip, 80 kg (größter üblicher Schirm ~14 m²).
 *  - min:    ab hier fahrbar (mit großem Kite)
 *  - good:   komfortabel
 *  - strong: ab hier kleine Schirme, anstrengend
 *  - over:   zu viel für die meisten
 */
export type Thresholds = { min: number; good: number; strong: number; over: number };
export const TH: Thresholds = { min: 13, good: 18, strong: 27, over: 35 };

export type Tone = "grey" | "blue" | "teal" | "green" | "amber" | "orange" | "red";

export function toneOf(kt: number | null, th: Thresholds): Tone {
  if (kt == null) return "grey";
  if (kt < th.min - 3) return "grey";
  if (kt < th.min) return "blue";
  if (kt < th.good) return "teal";
  if (kt < th.strong) return "green";
  if (kt < th.over) return "amber";
  if (kt < th.over + 8) return "orange";
  return "red";
}

const RATING_LABEL: Record<Tone, string> = {
  grey: "zu wenig",
  blue: "knapp",
  teal: "fahrbar",
  green: "gut",
  amber: "kräftig",
  orange: "zu viel",
  red: "gefährlich",
};

export function ratingLabel(kt: number | null, th: Thresholds): string {
  return kt == null ? "keine Daten" : RATING_LABEL[toneOf(kt, th)];
}

// ── Richtung ───────────────────────────────────────────────────────────────────────────

export type DirQuality = "good" | "ok" | "bad";

function inSector(deg: number, [from, to]: [number, number]): boolean {
  const d = ((deg % 360) + 360) % 360;
  return from <= to ? d >= from && d <= to : d >= from || d <= to;
}

/** Spot-Hinweis zur Richtung (z. B. „bei S/O auf die Grevelingen-Seite"), sofern hinterlegt. */
export function dirHint(deg: number | null, dirs: DirSectors): string | null {
  if (deg == null) return null;
  return dirs.hints?.find((h) => inSector(deg, h.range))?.text ?? null;
}

export function dirQuality(deg: number | null, dirs: DirSectors): DirQuality | null {
  if (deg == null) return null;
  if (dirs.good.some((s) => inSector(deg, s))) return "good";
  if (dirs.ok.some((s) => inSector(deg, s))) return "ok";
  return "bad";
}

export const DIR_LABEL: Record<DirQuality, string> = {
  good: "Richtung gut",
  ok: "Richtung bedingt",
  bad: "ablandig / ungeeignet",
};

// ── Kurzfrist-Korrektur ─────────────────────────────────────────────────────────────────

// Dreht der Wind um mehr als so viel Grad gegenüber der Messstunde, gilt die Lage als
// umgestellt (Front/Seebrise) — die aktuelle Abweichung sagt dann nichts mehr aus.
export const FRONT_TURN_DEG = 60;

/**
 * Zeitpunkt, ab dem die Kurzfrist-Korrektur nicht mehr gilt: erste Prognosestunde nach der
 * Messung, deren Richtung um > 60° von der Richtung zur Messzeit abweicht.
 */
export function nowcastCutoff(spot: SpotPayload): number | null {
  const nc = spot.nowcast;
  if (!nc) return null;
  const pts = spot.points.filter((p) => p.winddir != null);
  const ref = pts.find((p) => p.t >= nc.t0 - 3600);
  if (!ref) return null;
  for (const p of pts) {
    if (p.t <= ref.t) continue;
    const d = Math.abs(((p.winddir! - ref.winddir! + 540) % 360) - 180);
    if (d > FRONT_TURN_DEG) return p.t;
  }
  return null;
}

/**
 * Anteil der aktuellen Mess-Abweichung, der zum Zeitpunkt t noch gilt — Nachlauf aus den
 * Daten gelernt (`gain[k]`, k = Stunden nach der Messung, dazwischen linear), ab einer
 * Front (`cutoff`) null.
 */
export function nowcastOffsetAt(nc: Nowcast | null, t: number, cutoff: number | null = null): number {
  if (!nc || !nc.gain.length) return 0;
  if (cutoff != null && t >= cutoff) return 0;
  const dtH = Math.max(0, t - nc.t0) / 3600;
  const k = Math.floor(dtH);
  if (k >= nc.gain.length - 1) return 0;
  const g = nc.gain[k] + (nc.gain[k + 1] - nc.gain[k]) * (dtH - k);
  return nc.offset * g;
}

// ── Stunden-Bewertung ──────────────────────────────────────────────────────────────────

export type HourEval = {
  t: number;
  i: number; // Index im Konsens-Gitter
  day: string;
  wind: number | null; // Konsens inkl. Kurzfrist-Korrektur (kn)
  gust: number | null;
  dir: number | null;
  pMin: number | null; // Anteil (gewichtet) der Modelle ≥ Mindestwind
  dirQ: DirQuality | null;
  daylight: boolean;
  squall: boolean; // Schauerböen-Verdacht (Regen + stark böig)
  hiRes: boolean; // mind. ein hochauflösendes Modell (≤ 3 km) deckt die Stunde ab
  rideable: boolean;
};

const HI_RES_KM = 3;
const TZ = "Europe/Amsterdam";
const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ });
export const dayKeyOf = (sec: number) => dayFmt.format(new Date(sec * 1000));

/**
 * P(Wind ≥ kn) zum Gitterindex i: jedes (korrigierte) Modell trägt eine Normalverteilung mit
 * seinem typischen, kalibrierten Restfehler σ bei (Ensemble-Dressing), gewichtet wie im
 * Konsens. `offset` = Kurzfrist-Korrektur für diese Stunde.
 */
export function probAtLeast(spot: SpotPayload, i: number, kn: number, offset = 0): number | null {
  const items: { v: number; w: number; sigma: number }[] = [];
  for (const m of spot.models) {
    const v = m.windAdj?.[i] ?? m.wind[i];
    if (v == null) continue;
    items.push({ v: v + offset, w: m.wh?.[i] ?? (m.weight > 0 ? m.weight : 0.001), sigma: m.sigma?.[i] ?? 3 });
  }
  return mixtureProb(items, kn);
}

/** Schauerböen-Ersatzsignal (Windguru liefert kein CAPE): Schauer ≥ 1.5 mm/h + stark böig. */
function isSquall(precip: number | null, wind: number | null, gust: number | null): boolean {
  if (precip == null || precip < 1.5 || wind == null || gust == null) return false;
  return gust - wind >= 12 || (wind > 5 && gust / wind >= 1.6);
}

export function evaluateHours(spot: SpotPayload, th: Thresholds): HourEval[] {
  const sunByDay = new Map(spot.trend.daily.map((d) => [d.day, { rise: d.sunrise, set: d.sunset }]));
  const hiResIdx = spot.models
    .map((m, k) => ({ m, k }))
    .filter(({ m }) => m.resolution != null && m.resolution <= HI_RES_KM && m.weight > 0);

  const cutoff = nowcastCutoff(spot);
  return spot.points.map((p, i) => {
    const day = dayKeyOf(p.t);
    const off = nowcastOffsetAt(spot.nowcast, p.t, cutoff);
    const wind = p.windspd == null ? null : Math.max(0, p.windspd + off);
    const gust = p.gust == null ? null : Math.max(wind ?? 0, p.gust + off);
    const sun = sunByDay.get(day);
    const daylight = sun ? p.t >= sun.rise - 1800 && p.t <= sun.set - 1800 : false;
    const pMin = probAtLeast(spot, i, th.min, off);
    const dirQ = dirQuality(p.winddir, spot.dirs);
    const squall = isSquall(p.precip, wind, gust);
    const hiRes = hiResIdx.some(({ m }) => (m.windAdj?.[i] ?? m.wind[i]) != null);
    const rideable =
      daylight && dirQ !== "bad" && dirQ != null && (pMin ?? 0) >= 0.5 && (wind ?? 0) < th.over && !squall;
    return { t: p.t, i, day, wind, gust, dir: p.winddir, pMin, dirQ, daylight, squall, hiRes, rideable };
  });
}

// ── Fahrfenster ────────────────────────────────────────────────────────────────────────

export type RideWindow = {
  day: string;
  start: number; // Unix-Sek. (erste Stunde)
  end: number; // Unix-Sek. (Ende = letzte Stunde + 1 h)
  lo: number; // schwächste Stunde (kn)
  hi: number; // stärkste Stunde (kn)
  dir: number | null; // mittlere Richtung
  prob: number; // Ø der stündlichen P(≥ Mindestwind) — NICHT die Chance, dass das ganze Fenster hält
  dirQ: DirQuality; // schlechteste Richtungsqualität im Fenster
  hours: number;
  hiRes: boolean; // komplett durch hochauflösende Modelle abgedeckt
};

export const MIN_WINDOW_H = 2;

function meanDir(dirs: (number | null)[]): number | null {
  let x = 0;
  let y = 0;
  for (const d of dirs) {
    if (d == null) continue;
    x += Math.cos((d * Math.PI) / 180);
    y += Math.sin((d * Math.PI) / 180);
  }
  if (x === 0 && y === 0) return null;
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round(deg < 0 ? deg + 360 : deg);
}

/** Zusammenhängende fahrbare Stunden (≥ MIN_WINDOW_H) eines Tages → Fenster. */
export function findWindows(hours: HourEval[]): RideWindow[] {
  const out: RideWindow[] = [];
  let run: HourEval[] = [];
  const flush = () => {
    if (run.length >= MIN_WINDOW_H) {
      const winds = run.map((h) => h.wind ?? 0);
      out.push({
        day: run[0].day,
        start: run[0].t,
        end: run[run.length - 1].t + 3600,
        lo: Math.min(...winds),
        hi: Math.max(...winds),
        dir: meanDir(run.map((h) => h.dir)),
        prob: run.reduce((a, h) => a + (h.pMin ?? 0), 0) / run.length,
        dirQ: run.some((h) => h.dirQ === "ok") ? "ok" : "good",
        hours: run.length,
        hiRes: run.every((h) => h.hiRes),
      });
    }
    run = [];
  };
  for (const h of hours) {
    const contiguous = run.length && h.t - run[run.length - 1].t === 3600 && h.day === run[0].day;
    if (h.rideable && (contiguous || !run.length)) run.push(h);
    else {
      flush();
      if (h.rideable) run.push(h);
    }
  }
  flush();
  return out;
}

/** Bestes Fenster: das mit der größten „sicheren Fahrzeit" (Stunden × Wahrscheinlichkeit). */
export function bestWindow(ws: RideWindow[]): RideWindow | null {
  return ws.reduce<RideWindow | null>((best, w) => (!best || w.hours * w.prob > best.hours * best.prob ? w : best), null);
}

// ── Tages-Zusammenfassung ──────────────────────────────────────────────────────────────

export type TrendState = { state: "stabil" | "steigt" | "fällt"; delta: number; since: string };

export type DaySummary = {
  day: string;
  label: string;
  peak: number | null; // Ø stärkste 3 Tageslicht-Stunden (Konsens)
  gust: number | null;
  dir: number | null;
  modelPeak: number | null; // gewichteter Median der Modell-Spitzen (zeitversatz-unabhängig)
  windows: RideWindow[];
  best: RideWindow | null;
  globalOnly: boolean; // keine hochauflösenden Modelle mehr → unsicherer
  trend: TrendState | null;
};

function weightedMedian(xs: { v: number; w: number }[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a.v - b.v);
  const total = s.reduce((a, x) => a + x.w, 0);
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc += s[i].w;
    // Genau die Hälfte erreicht (z. B. zwei gleich gewichtete Modelle): Mitte zum nächsten
    // Wert — sonst wäre die „Modell-Spitze" zufällig das schwächere der beiden.
    if (Math.abs(acc - total / 2) < 1e-9 * total && i + 1 < s.length) return (s[i].v + s[i + 1].v) / 2;
    if (acc >= total / 2) return s[i].v;
  }
  return s[s.length - 1].v;
}

export function summarizeDays(spot: SpotPayload, hours: HourEval[]): DaySummary[] {
  return spot.trend.daily.map((d) => {
    const dayHours = hours.filter((h) => h.day === d.day && h.daylight);
    const windows = findWindows(hours.filter((h) => h.day === d.day));

    // Modell-Spitze: jedes Modell für sich (Ø seiner 3 stärksten Tageslicht-Stunden), dann
    // gewichteter Median. Unempfindlich dagegen, dass Modelle die Front zeitlich versetzt sehen.
    // Gewicht = Summe seiner Stundengewichte AN DIESEM TAG — nicht der Anteil über 16 Tage,
    // sonst zählten die hochauflösenden Kurzfrist-Modelle gerade morgen fast nichts.
    const peaks = spot.models
      .map((m) => {
        const vals = dayHours.map((h) => m.windAdj?.[h.i] ?? m.wind[h.i]);
        const n = vals.filter((v) => v != null).length;
        const w = dayHours.reduce((a, h) => a + (m.wh?.[h.i] ?? 0), 0);
        return n >= 3 ? { v: topKMean(vals, 3)!, w: w > 0 ? w : 0.001 } : null;
      })
      .filter((x): x is { v: number; w: number } => x != null);

    const dl = d.deltas.find((x) => x.key === "d1d" && x.delta != null) ?? d.deltas.find((x) => x.key === "d6h" && x.delta != null);
    const trend: TrendState | null = dl?.delta != null
      ? {
          state: Math.abs(dl.delta) < 2 ? "stabil" : dl.delta > 0 ? "steigt" : "fällt",
          delta: dl.delta,
          since: dl.key === "d1d" ? "seit gestern" : "seit 6 h",
        }
      : null;

    return {
      day: d.day,
      label: d.label,
      peak: d.peak,
      gust: d.peakGust,
      dir: d.dir,
      modelPeak: weightedMedian(peaks),
      windows,
      best: bestWindow(windows),
      globalOnly: dayHours.length > 0 && !dayHours.some((h) => h.hiRes),
      trend,
    };
  });
}
