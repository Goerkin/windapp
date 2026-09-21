// Einheiten & kleine Formathelfer. Basis ist immer Knoten (kn) + °C; die UI kann Wind nach
// m/s umschalten. Farbskala/Bewertung hängen vom Fahrer ab und liegen in kite.ts.

export type WindUnit = "kn" | "ms";

export function ktToMs(kt: number): number {
  return kt * 0.514444;
}

export function convertWind(kt: number | null, unit: WindUnit): number | null {
  if (kt == null) return null;
  if (unit === "ms") return Math.round(ktToMs(kt) * 10) / 10;
  return Math.round(kt * 10) / 10;
}

export function unitLabel(unit: WindUnit): string {
  return unit === "ms" ? "m/s" : "kn";
}

/**
 * Mittel der `k` höchsten Werte einer Reihe (nulls ignoriert). Robuster Tages-Kennwert:
 * glättet eine einzelne kurze Böe/Spitze, die für einen ganzen Tag nicht aussagekräftig ist.
 */
export function topKMean(vals: (number | null | undefined)[], k = 3): number | null {
  const nums = vals.filter((v): v is number => v != null).sort((a, b) => b - a);
  if (!nums.length) return null;
  const top = nums.slice(0, Math.min(k, nums.length));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

const COMPASS = [
  "N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function compass(deg: number | null): string {
  if (deg == null) return "–";
  return COMPASS[Math.round(deg / 22.5) % 16];
}
