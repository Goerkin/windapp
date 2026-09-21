// Farb-Palette als konkrete Hex-Werte — für Recharts (SVG-Attribute) und Inline-Styles.
// Muss zu den CSS-Variablen in globals.css passen.
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
  // Chart-Achsen: klar lesbar auf dunklem Grund
  axis: "#eaeef7", // Tick-Beschriftung (fast weiß, hoher Kontrast)
  axisLine: "#55618a", // Achsenlinie / Ticks
  gridLine: "#2b3654", // Gitter (etwas kräftiger als grid)
};

/** Windfarbe (Knoten) als Hex, relativ zu den Kite-Schwellen (Twintip, 80 kg). */
export function ktColorHex(kt: number | null): string {
  return PALETTE[toneOf(kt, TH)];
}

// Farbreihe für die Modell-Linien (bis ~16 Modelle), gut unterscheidbar auf Dunkel.
export const MODEL_COLORS = [
  "#22d3ee", "#a78bfa", "#f59e0b", "#34d399", "#f472b6", "#60a5fa",
  "#fbbf24", "#4ade80", "#c084fc", "#2dd4bf", "#fb7185", "#93c5fd",
  "#fcd34d", "#5eead4", "#e879f9", "#86efac",
];
