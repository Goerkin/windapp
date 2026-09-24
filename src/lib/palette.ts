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
import { TH, toneOf } from "./kite";

export const PALETTE = {
  grey: "#64748b",
  blue: "#3b82f6",
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
