// Statistisches Nachkorrektur-Modell (MOS-light) — framework-neutral, Server + Client.
//
// Je Spot × Modell × Vorlauf-Stufe wird der Fehler (Prognose − Messung) als Ridge-Regression
// beschrieben:
//
//   err ≈ β0 + s_Sektor + β1·(fc − 12 kn) + β2·(T_Wasser − T_Luft)
//
//  - β0 + s_Sektor: systematischer Versatz, je Richtungs-Quadrant (N/O/S/W) verschieden
//  - β1: windstärkeabhängiger Fehler (z. B. zu viel bei Flaute, zu wenig bei Starkwind)
//  - β2: Schichtung — wärmeres Wasser mischt die Luft durch, an der Küste weht es mehr
//
// Welche Terme aktiv sind, bestimmt der Modus (raw/add/lin/linT). Die rollierende
// Verifikation in skill.ts testet mehrere Varianten (Modus × Gewichtung) ehrlich (nur mit
// Daten VOR dem jeweiligen Prognosezeitpunkt) und wählt die einfachste, die innerhalb von
// 0.05 kn an die beste herankommt. Gewichte je Modell = 1/σ² (Restfehler nach Korrektur,
// zum auflösungsbasierten Prior geshrinkt) oder gleich.

export type Mode = "raw" | "add" | "lin" | "linT";
export type WeightScheme = "equal" | "skill";
export type Variant = { key: string; label: string; mode: Mode; weights: WeightScheme };

/** Nach Komplexität sortiert — bei Gleichstand gewinnt die einfachere Variante. */
export const VARIANTS: Variant[] = [
  { key: "raw_equal", label: "Roh · gleiche Gewichte", mode: "raw", weights: "equal" },
  { key: "raw_skill", label: "Roh · Güte-Gewichte", mode: "raw", weights: "skill" },
  { key: "add_equal", label: "Bias-Korrektur · gleiche Gewichte", mode: "add", weights: "equal" },
  { key: "add_skill", label: "Bias-Korrektur · Güte-Gewichte", mode: "add", weights: "skill" },
  { key: "lin_skill", label: "Linear-Korrektur · Güte-Gewichte", mode: "lin", weights: "skill" },
  { key: "linT_skill", label: "Linear + Wasser−Luft-Temp. · Güte-Gewichte", mode: "linT", weights: "skill" },
];
export const DEFAULT_VARIANT = "add_skill";
export const variantOf = (key: string | undefined): Variant =>
  VARIANTS.find((v) => v.key === key) ?? VARIANTS.find((v) => v.key === DEFAULT_VARIANT)!;

// ── Vorlauf-Stufen ───────────────────────────────────────────────────────────────────────
/** 0–24 h, 24–48 h, 48–72 h, > 72 h — Güte und Korrektur werden je Stufe getrennt gelernt. */
export const LEAD_BUCKETS = 4;
export const LEAD_LABELS = ["0–24 h", "24–48 h", "48–72 h", "> 72 h"];
export function leadBucket(leadH: number): number {
  return Math.max(0, Math.min(LEAD_BUCKETS - 1, Math.floor(leadH / 24)));
}

// ── Merkmale ─────────────────────────────────────────────────────────────────────────────
// 0 = Achsenabschnitt, 1–4 = Quadranten N/O/S/W (Dummies), 5 = fc − 12, 6 = T_Wasser − T_Luft
export const N_FEAT = 7;
export const MODE_FEATS: Record<Mode, number[]> = {
  raw: [],
  add: [0, 1, 2, 3, 4],
  lin: [0, 1, 2, 3, 4, 5],
  linT: [0, 1, 2, 3, 4, 5, 6],
};
export const MODES: Mode[] = ["raw", "add", "lin", "linT"];

/**
 * Ridge-Strafen je Merkmal ≈ „so viele effektive Stunden Evidenz braucht es, um vom
 * Nullwert wegzukommen" × typische Merkmalsgröße². Quadranten schwächer als der Gesamt-
 * versatz (hierarchisches Shrinkage), Steigung/Temperatur deutlich zurückhaltend.
 */
export const RIDGE = [4, 12, 12, 12, 12, 15 * 36, 15 * 9];

const REF_KN = 12;
export const MAX_CORR_KN = 6;

export function quadrant(dir: number): number {
  return Math.round((((dir % 360) + 360) % 360) / 90) % 4;
}

export function features(fc: number, dir: number | null, dT: number | null): number[] {
  const x = new Array(N_FEAT).fill(0);
  x[0] = 1;
  if (dir != null) x[1 + quadrant(dir)] = 1;
  x[5] = fc - REF_KN;
  x[6] = dT ?? 0;
  return x;
}

// ── Parameter ────────────────────────────────────────────────────────────────────────────
export type ModeFit = { beta: number[]; sigma: number };
/** Je Vorlauf-Stufe die Fits aller Modi. */
export type ModelParams = { resolution: number | null; n: number[]; fits: Record<Mode, ModeFit>[] };
export type SpotParams = {
  variant: string;
  models: Record<string, ModelParams>;
  sigmaScale: number; // Kalibrierfaktor für die Wahrscheinlichkeit (Brier-optimal)
  nowcastGain: number[]; // Anteil der Mess-Abweichung, der k Stunden später noch gilt (k = 0..8)
  fittedAt: number;
};

/**
 * Erwarteter Fehler (MAE) eines Modells allein aus seiner Auflösung — Prior ohne Historie.
 * Feiner aufgelöst ⇒ an der Küste tendenziell genauer.
 */
export function priorMAE(resolution?: number | null): number {
  const res = resolution && resolution > 0 ? resolution : 15;
  return Math.min(6, Math.max(3, 3 + Math.max(0, res - 2) * 0.12));
}

/** Prior-Standardabweichung je Auflösung und Vorlauf-Stufe (Fehler wächst mit dem Vorlauf). */
export function priorSigma(resolution: number | null | undefined, bucket: number): number {
  return 1.25 * priorMAE(resolution) * (1 + 0.12 * bucket);
}

export function priorFit(resolution: number | null | undefined, bucket: number): ModeFit {
  return { beta: new Array(N_FEAT).fill(0), sigma: priorSigma(resolution, bucket) };
}

function fitFor(p: SpotParams | null | undefined, idModel: number, res: number | null | undefined, bucket: number, mode: Mode): ModeFit {
  return p?.models[String(idModel)]?.fits[bucket]?.[mode] ?? priorFit(res, bucket);
}

/**
 * Korrektur + Gewicht + Unsicherheit eines Modellwerts. `shift` = abzuziehender
 * vorhergesagter Fehler (gekappt), `w` = Konsens-Gewicht, `sigma` = Restfehler (kn).
 */
export function modelHour(
  p: SpotParams | null | undefined,
  variant: Variant,
  idModel: number,
  res: number | null | undefined,
  leadH: number,
  fc: number,
  dir: number | null,
  dT: number | null,
): { wind: number; shift: number; w: number; sigma: number } {
  const bucket = leadBucket(leadH);
  const fit = fitFor(p, idModel, res, bucket, variant.mode);
  let shift = 0;
  if (variant.mode !== "raw") {
    const x = features(fc, dir, dT);
    for (const k of MODE_FEATS[variant.mode]) shift += fit.beta[k] * x[k];
    shift = Math.max(-MAX_CORR_KN, Math.min(MAX_CORR_KN, shift));
  }
  const sigma = Math.max(0.8, fit.sigma);
  return {
    wind: Math.max(0, fc - shift),
    shift,
    w: variant.weights === "equal" ? 1 : 1 / (sigma * sigma),
    sigma: sigma * (p?.sigmaScale ?? 1),
  };
}

// ── Mathe-Helfer ─────────────────────────────────────────────────────────────────────────

/** Standardnormal-Verteilungsfunktion Φ(z) (Abramowitz-Stegun 7.1.26, |ε| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * P(Wind ≥ kn) als gewichtete Mischung von Normalverteilungen um die (korrigierten)
 * Modellwerte — „Ensemble-Dressing". Weicher und ehrlicher als der harte Anteil der Modelle
 * über der Schwelle, weil jedes Modell seinen typischen Fehler mitbringt.
 */
export function mixtureProb(items: { v: number; w: number; sigma: number }[], kn: number): number | null {
  let wSum = 0;
  let acc = 0;
  for (const it of items) {
    wSum += it.w;
    acc += it.w * (1 - normCdf((kn - it.v) / Math.max(0.5, it.sigma)));
  }
  return wSum > 0 ? acc / wSum : null;
}

/** Löst (A)x = b für kleine symmetrische Systeme (Gauß mit Pivotsuche). */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}
