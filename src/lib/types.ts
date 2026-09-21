// Geteilte, framework-neutrale Typen (client- und serverseitig importierbar).
import type { ConsensusPoint } from "./consensus";
import type { DirSectors } from "./spots";
export type { ConsensusPoint, DirSectors };

export type ModelView = {
  idModel: number;
  label: string;
  longname: string | null;
  category: string;
  note: string;
  resolution: number | null;
  koef: number;
  initStamp: number;
  weight: number; // Anteil am Konsens (0..1, normiert)
  mae: number | null; // recency-gewichteter MAE ggü. Messung (kn), sofern bewertet
  bias: number | null; // recency-gewichteter Bias, Prognose − Messung (kn)
  samples: number; // effektive Stichprobenzahl der Bewertung
  wind: (number | null)[]; // Rohwerte des Modells
  windAdj: (number | null)[]; // nachkorrigiert (Variante des Spots) → Wahrscheinlichkeiten
  sigma: (number | null)[]; // typischer Restfehler je Stunde (kn, kalibriert)
  wh: (number | null)[]; // Konsens-Gewicht je Stunde (unnormiert)
};

/**
 * Kurzfrist-Korrektur aus der Live-Messung: Abweichung Messung − Prognose zum jüngsten
 * Messzeitpunkt. Sie wird auf die nächsten Stunden übertragen; wie stark, sagt `gain[k]`
 * (k Stunden nach der Messung; aus den Daten gelernt).
 */
export type Nowcast = {
  station: string;
  t0: number; // Unix-Sek. der Messung
  measured: number; // gemessener Wind (kn, Ø der letzten ~60 min)
  forecast: number; // Konsens zum selben Zeitpunkt (kn)
  offset: number; // measured − forecast
  gain: number[]; // Anteil der Abweichung, der nach k h noch gilt (k = 0..8)
  halfLifeH: number | null; // nach wie vielen Stunden die Hälfte übrig ist
};

/** Prognose eines früheren Datenstands (≈ 24 h alt) + ihr Fehler gegen die Messung seitdem. */
export type PastForecast = {
  fetchedAt: string;
  points: { t: number; wind: number | null; gust: number | null }[];
  mae: number | null; // Ø Abweichung von der Messung in den vergangenen Stunden (kn)
  bias: number | null; // Prognose − Messung (kn)
  n: number; // verglichene Stunden
};

/** Aktives Rechenverfahren des Spots (für die Anzeige). */
export type Method = { variant: string; label: string; sigmaScale: number; fittedAt: number | null };

/** Ein Eintrag im Modell-Güte-Ranking eines Spots (aus der materialisierten Bewertung). */
export type SkillView = {
  idModel: number;
  label: string;
  category: string;
  resolution: number | null;
  mae: number | null;
  bias: number | null;
  samples: number;
  weight: number; // normierter Konsens-Anteil (0..1)
  maeCorr: number | null; // typischer Restfehler nach Korrektur (Vorlauf 0–24 h, ≈ 0.8 σ)
};

export type TrendRun = { fetchedAt: string; wind: (number | null)[] };

/** Änderung der Tages-Spitze gegenüber einem früheren Datenstand einer Kadenz. */
export type TrendDelta = {
  key: string; // "d6h" | "d1d" | "d3d" | "d7d"
  label: string; // "6 h" | "1 T" | "3 T" | "7 T"
  hours: number; // Alter des Vergleichsstands in Stunden
  prev: number | null; // Spitze im Vergleichsstand
  delta: number | null; // peak - prev
};

export type DailyTrend = {
  day: string;
  label: string;
  peak: number | null; // Ø der 3 stärksten TAGESLICHT-Stunden (Konsens)
  peakGust: number | null;
  dir: number | null;
  deltas: TrendDelta[]; // 6 h / 1 T / 3 T / 7 T
  sunrise: number; // Unix-Sek.
  sunset: number;
};

/** Ein einzelner Live-Messpunkt der Station (Wind in kn, Richtung in Grad). */
export type StationObsPoint = {
  t: number; // Unix-Sekunden
  windAvg: number | null;
  windMax: number | null;
  windDir: number | null;
};

/** Live-Messstation eines Spots: aktueller Wert + kurze Historie zum Vergleich mit der Prognose. */
export type StationView = {
  id: number;
  name: string;
  obsTime: string | null; // ISO des jüngsten Messwerts
  ageMin: number | null; // Alter des jüngsten Messwerts in Minuten
  windAvg: number | null;
  windMax: number | null;
  windMin: number | null;
  windDir: number | null;
  temp: number | null;
  series: StationObsPoint[]; // jüngste Messungen (aufsteigend), für die Chart-Überlagerung
};

export type SpotPayload = {
  id: number;
  slug: string;
  name: string;
  region: string | null;
  lat: number;
  lon: number;
  dirs: DirSectors; // Windrichtungs-Eignung des Spots
  fetchedAt: string | null;
  sunrise: string | null;
  sunset: string | null;
  waterTemp: number | null; // Windguru-Schätzung (Rückfall)
  water: { code: string; name: string; value: number; obsTime: string }[]; // gemessen (Rijkswaterstaat), Referenz zuerst
  timezone: string | null;
  now: ConsensusPoint | null;
  nowcast: Nowcast | null;
  method: Method;
  points: ConsensusPoint[];
  gridTimes: number[];
  models: ModelView[];
  skill: SkillView[]; // Modell-Güte-Ranking (materialisiert), bestes zuerst
  contributors: { idModel: number; modelName: string; weight: number }[];
  trend: { runs: TrendRun[]; daily: DailyTrend[]; refFetchedAt: string | null };
  pastForecast: PastForecast | null;
  stations: StationView[];
  verification: Verification | null;
  empty?: boolean;
};

/** Gütewerte des Konsens gegenüber den Messungen für eine Vorlaufzeit. */
export type VerificationLead = {
  leadH: number; // Vorlauf in Stunden (Prognose stand ~leadH vor dem Zeitpunkt)
  label: string;
  n: number; // Anzahl verglichener Stunden
  mae: number | null; // mittlerer absoluter Fehler (kn)
  bias: number | null; // mittlerer Fehler Prognose − Messung (kn)
  hit: number | null; // Anteil Treffer innerhalb ±3 kn (0..1)
};

/** Modell-Check je Tag: Vorhersage jedes Modells (fester Prognose-Stand) vs. Messung. */
export type ModelVerification = {
  days: { day: string; label: string }[]; // Tage mit Messungen (blätterbar)
  day: string; // aktuell gewählter Tag
  refFetchedAt: string | null; // Prognose-Stand, aus dem die Modelllinien stammen
  gridTimes: number[]; // Stunden des Tages (Unix-Sek)
  measured: (number | null)[]; // gemessener Wind je Stunde (kn, Mittel über Stationen)
  consensus: (number | null)[]; // Konsens je Stunde (kn)
  models: {
    idModel: number;
    label: string;
    resolution: number | null;
    weight: number;
    wind: (number | null)[]; // Modellvorhersage je Stunde (kn)
    mae: number | null; // mittlerer abs. Fehler ggü. Messung an diesem Tag (kn)
  }[];
};

/** MAE einer Rechenvariante je Vorlauf (rollierende Verifikation). */
export type VariantScore = {
  key: string;
  label: string;
  meanMae: number | null;
  leads: { leadH: number; n: number; mae: number | null }[];
};

/** Kalibrierung der Wahrscheinlichkeit P(≥ Schwelle). */
export type ProbVerification = {
  threshold: number;
  n: number;
  sigmaScale: number; // Brier-optimaler Streuungsfaktor
  brierDressed: number; // Brier-Score unserer Wahrscheinlichkeit (kleiner = besser)
  brierFraction: number; // … des harten „Anteil der Modelle"
  brierClimate: number | null; // … der Klimatologie (immer die Grundrate sagen)
  reliability: { lo: number; hi: number; n: number; pAvg: number | null; obsFreq: number | null }[];
};

/** Forecast-Verifikation: wie gut der Konsens den gemessenen Wind rückblickend traf. */
export type Verification = {
  windowDays: number;
  hitToleranceKn: number;
  obsHours: number; // Anzahl Messstunden im Fenster
  leads: VerificationLead[]; // gewählte Variante
  // Punktwolke Prognose (x) vs. Messung (y) für den Kern-Vorlauf, gekappt.
  scatter: { forecast: number; measured: number; leadH: number }[];
  outOfSample?: boolean; // nur mit Daten VOR dem jeweiligen Prognosezeitpunkt gelernt
  snapshots?: number; // Anzahl geprüfter Prognosezeitpunkte
  chosen?: string; // gewählte Variante
  variants?: VariantScore[];
  prob?: ProbVerification | null;
  nowcast?: { gain: number[]; pairs: number; halfLifeH: number | null } | null;
};
