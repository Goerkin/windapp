// Farben für Kontexte, in denen keine CSS-Klasse greift: Inline-Styles und SVG-Attribute.
//
// Zwei Formen, weil beides gebraucht wird:
//   ktColor()    → "var(--wg-…)". Für alles, was über CSS gerendert wird (style={{ color }},
//                  background, borderColor, style={{ fill }}). Kippt automatisch mit dem
//                  hellen/dunklen Thema — das ist der Normalfall.
//   ktColorHex() → fester Hex-Wert. Nur wo CSS-Variablen nicht funktionieren: wenn eine
//                  Deckkraft angehängt wird ("…d9") oder ein Wert berechnet werden muss.
//                  Diese Werte kippen NICHT mit dem Thema — deshalb nur auf gesättigten
//                  Kachelflächen benutzen, die in beiden Themen gleich aussehen sollen.
//
// PALETTE trägt zusätzlich das Diagramm-Chrome. Diese Werte gehen als SVG-Attribut an
// Recharts und werden in globals.css themenabhängig überschrieben (CSS gewinnt gegen
// Präsentationsattribute) — sie sind also der Dunkel-Fall und gleichzeitig der Rückfall.
//
// Datenreihen (Wind, Böen, Messung …) laufen genauso: Farbe als CSS-Variable (--series-*, je
// Thema eigene Töne), an Recharts-Linien per Klasse (SERIES_CLASS) — ein SVG-Attribut kann
// keine Variable auflösen. Früher standen hier nur die Dunkel-Töne; auf Weiß hatte die
// Windlinie damit 1,8 : 1 Kontrast.
import { TH, toneOf } from "./kite";

export const PALETTE = {
  grey: "#64748b",
  blue: "#7c93b8", // „knapp" — entsättigt, siehe --wg-blue in globals.css
  teal: "#22d3ee",
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
  red: "#ef4444",
  gust: "#a78bfa",
  band: "#22d3ee",
  ink: "#e8edf6",
  muted: "#8a93a8",
  grid: "#1e2740",
  panel: "#121a2e",
  // Chart-Achsen — in globals.css je Thema überschrieben (--chart-axis …).
  axis: "#eaeef7",
  axisLine: "#55618a",
  gridLine: "#2b3654",
};

/** Windfarbe (Knoten) als CSS-Variable — kippt mit dem Thema. Bevorzugte Form. */
export function ktColor(kt: number | null): string {
  return `var(--wg-${toneOf(kt, TH)})`;
}

/** Windfarbe als fester Hex-Wert — nur wo eine Deckkraft angehängt wird (siehe oben). */
export function ktColorHex(kt: number | null): string {
  return PALETTE[toneOf(kt, TH)];
}

// Farbreihe für die Modell-Linien (bis ~16 Modelle). Mitteltöne, damit sie in beiden Themen
// tragen — Linien, kein Text.
export const MODEL_COLORS = [
  "#0891b2", "#8b5cf6", "#d97706", "#059669", "#db2777", "#2563eb",
  "#ca8a04", "#16a34a", "#9333ea", "#0d9488", "#e11d48", "#3b82f6",
  "#a16207", "#14b8a6", "#c026d3", "#4d7c0f",
];

/**
 * Datenreihen der Diagramme als CSS-Variablen (für style/Legende/Tooltip) und als Klasse (für
 * Recharts-Linien; die Regeln stehen in globals.css). Wind = Tinte wie der Konsens in der
 * Analyse — nicht Türkis, das heißt in den Kacheln „fahrbar" und stünde sonst auch bei 3 kn da.
 */
export const SERIES = {
  wind: "var(--series-wind)",
  gust: "var(--series-gust)",
  past: "var(--series-past)",
} as const;
export const SERIES_CLASS = {
  wind: "series-wind",
  gust: "series-gust",
  past: "series-past",
} as const;
/** Rückfall fürs SVG-Attribut (z. B. aktiver Punkt) — ein Mittelton, der in beiden Themen trägt. */
export const SERIES_FALLBACK = { wind: "#64748b", gust: "#8b5cf6", past: "#94a3b8" } as const;

// Gemessene Stationen — deutlich abgesetzt von Prognose und Windskala (pink, indigo, stein).
// Einzige Stelle; Diagramm, Kopfzeile und Modell-Check lesen hier.
const STATION_N = 3;
const STATION_FALLBACK = ["#db2777", "#6366f1", "#78716c"];
/** Stationsfarbe als CSS-Variable — kippt mit dem Thema. */
export const stationColor = (i: number) => `var(--series-station-${(i % STATION_N) + 1})`;
/** Klasse für die Recharts-Linie einer Station (Regeln in globals.css). */
export const stationClass = (i: number) => `series-station-${(i % STATION_N) + 1}`;
/** Rückfall fürs SVG-Attribut. */
export const stationFallback = (i: number) => STATION_FALLBACK[i % STATION_N];

// Modell-Kategorien (Analyse) als CSS-Variablen — kippen mit dem Thema.
export const CAT_LABEL: Record<string, string> = {
  mesoscale: "hochauflösend",
  "regional-hi": "regional",
  global: "global",
};
const CAT_VAR: Record<string, string> = { mesoscale: "--cat-meso", "regional-hi": "--cat-regional", global: "--cat-global" };
/** Kategorie-Farbe; mit `alpha` (0..1) als durchscheinende Variante (für Rahmen). */
export function catColor(cat: string, alpha?: number): string {
  const v = `var(${CAT_VAR[cat] ?? "--color-muted"})`;
  return alpha == null ? v : `color-mix(in srgb, ${v} ${Math.round(alpha * 100)}%, transparent)`;
}
