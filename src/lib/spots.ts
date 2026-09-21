// Statische Stammdaten: die beiden Spots und die Modell-Metadaten für die Tiefen-Ansicht.
// Windguru liefert Modellname/Auflösung/Gewicht dynamisch mit; hier ergänzen wir kurze
// deutsche Beschreibungen + Kategorie, damit die "Modelle im Detail"-Ansicht erklärt, was
// jedes Modell ist und warum es für Brouwersdam/Mirns relevant ist.

// Quelle einer Live-Messstation:
//  - "windguru": Windguru-Station, id = id_station (q=station_data_current, Werte in kn)
//  - "soarcast": NKV/soarcast-Messnetz, id = location_id (mv_measurement_location_markers,
//    Werte in m/s → werden in kn umgerechnet)
export type StationSource = "windguru" | "soarcast";

export type StationDef = {
  id: number; // id_station (windguru) bzw. location_id (soarcast)
  name: string; // Anzeigename der Messstation
  source: StationSource;
};

/**
 * Windrichtungs-Eignung eines Spots als Sektoren [von, bis] in Grad (Herkunft, im
 * Uhrzeigersinn; 350→20 überquert Nord). `good` = on-/sideshore, sicher;
 * `ok` = fahrbar mit Einschränkung (ablandig-ish, anderer Einstieg nötig). Alles andere gilt
 * als ungeeignet → wird in Fenstern ausgeschlossen und gewarnt. `hints` = spotbezogene
 * Tipps je Sektor (z. B. welche Seite des Damms). Grenzen = Mitte zwischen 16er-Rosen-Punkten.
 */
export type DirSectors = {
  good: [number, number][];
  ok: [number, number][];
  hints?: { range: [number, number]; text: string }[];
};

/**
 * Rijkswaterstaat-Messstelle für die Wassertemperatur (DDAPI20, Grootheid T, Compartiment
 * OW; 10-min-Werte). Die ERSTE Stelle je Spot ist die Referenz (Anzeige + Rechnung).
 */
export type WaterStationDef = { code: string; name: string };

export type SpotDef = {
  id: number; // Windguru id_spot
  slug: string;
  name: string;
  region: string;
  sortOrder: number;
  lat: number; // Fallback, falls die DB (noch) keine Koordinaten hat
  lon: number;
  dirs: DirSectors;
  water?: WaterStationDef[];
  // Live-Messstationen, deren Werte gegen die Prognose gelegt werden (0..n).
  stations?: StationDef[];
};

export const SPOTS: SpotDef[] = [
  {
    id: 97,
    slug: "brouwersdam",
    name: "Brouwersdam",
    region: "Zeeland · NL",
    sortOrder: 0,
    lat: 51.767,
    lon: 3.853,
    // SW–NW: am Damm side-/side-onshore (W/NW ideal). S–O: fahrbar auf der
    // Grevelingen-Seite bzw. im Hafenbereich. N–NO: nicht beschrieben → vorsichtig „bedingt".
    dirs: {
      good: [[214, 326]],
      ok: [[326, 214]],
      hints: [
        { range: [304, 326], text: "NW: am Damm onshore — besser am Ende der Promenade (Ouddorp)" },
        { range: [90, 214], text: "S/O: Grevelingenmeer-Seite oder Hafenbereich nutzen" },
        { range: [326, 90], text: "N/NO: ungeprüft — vor Ort einschätzen" },
      ],
    },
    stations: [{ id: 521, name: "Natural High", source: "windguru" }],
    // 3.4 km vor dem Damm (Nordsee) + Grevelingen-Seite (relevant bei S/O-Wind).
    water: [
      { code: "brouwershavensche.gat.08", name: "Nordsee" },
      { code: "bommenede", name: "Grevelingen" },
    ],
  },
  {
    id: 3642,
    slug: "mirns",
    name: "Mirns",
    region: "Friesland · IJsselmeer · NL",
    sortOrder: 1,
    lat: 52.853,
    lon: 5.473,
    // SO/S/SW optimal (konstant, on-/sideshore), W/WNW gut (Freeride). O fahrbar, aber
    // ablandig und oft wenig Wasser am Ufer. N-Sektor (NNW–NO) ablandig/böig → vermeiden.
    // NW ist nicht beschrieben → Übergang, „bedingt".
    dirs: {
      good: [[124, 304]],
      ok: [[56, 124], [304, 326]],
      hints: [
        { range: [56, 124], text: "O: ablandig, oft wenig Wasser am Ufer" },
        { range: [304, 326], text: "NW: Übergang zum Nord-Sektor — vorsichtig" },
        { range: [326, 56], text: "Nord: ablandig & unbeständig — fatal für den Einstieg" },
      ],
    },
    // Mirns NKV misst direkt am Spot — die Referenzmessung für Bewertung/Skill.
    stations: [{ id: 154, name: "Mirns NKV", source: "soarcast" }],
    water: [{ code: "friesekust.ijsselmeer", name: "IJsselmeer" }], // 3.4 km vor Mirns
  },
];

/**
 * Die aktuell definierten Mess-Stations-IDs eines Spots. Alle Mess-Aggregationen
 * (Verifikation, Skill, Live-Kacheln) filtern darauf — so zählen entfernte Stationen
 * (z. B. Hindeloopen) sofort nicht mehr mit, auch wenn alte Zeilen noch in der DB liegen.
 */
export function spotStationIds(spotId: number): number[] {
  return SPOTS.find((s) => s.id === spotId)?.stations?.map((st) => st.id) ?? [];
}

export type ModelInfo = {
  category: "global" | "regional-hi" | "mesoscale";
  label: string; // kurzer Anzeigename
  note: string; // 1 Satz: was & warum relevant
};

// Bekannte Windguru-Modell-IDs (aus forecast_spot beobachtet). Fällt ein unbekanntes Modell
// dazu, greift ein Default anhand der Auflösung.
export const MODEL_INFO: Record<number, ModelInfo> = {
  103: { category: "mesoscale", label: "MET Nordic 1 km", note: "MET Norway 1 km — sehr hoch aufgelöst, deckt aber primär Skandinavien ab; Mirns liegt am Südrand der Domäne (mit Vorsicht gewichten)." },
  52: { category: "mesoscale", label: "AROME 1.3 km", note: "Météo-France Hochauflösung — sehr feine Küstendynamik am Rand des Benelux-Raums." },
  48: { category: "mesoscale", label: "HARMONIE-NL 2 km", note: "KNMI HARMONIE — das Referenzmodell für die niederländische Küste, top für Brouwersdam & IJsselmeer." },
  109: { category: "mesoscale", label: "HARMONIE-DK 2 km", note: "DMI HARMONIE — hochauflösend für Nordsee/dänischen Raum." },
  101: { category: "mesoscale", label: "UKV 2 km", note: "UK Met Office — sehr gut für Nordsee-Anströmung aus West." },
  44: { category: "mesoscale", label: "ICON-D2 2.2 km", note: "DWD Hochauflösung Mitteleuropa — verlässlich bei Schauer-/Böenlagen." },
  107: { category: "mesoscale", label: "ALADIN 2.3 km", note: "Hochauflösendes regionales Modell." },
  99: { category: "mesoscale", label: "HARMONIE-FI 2.5 km", note: "FMI HARMONIE — Ostsee-/Nordeuropa-Fokus." },
  64: { category: "mesoscale", label: "Zephr-HD 2.6 km", note: "Windguru-eigenes hochauflösendes Modell." },
  57: { category: "regional-hi", label: "HARMONIE 5 km", note: "HARMONIE mittlere Auflösung." },
  43: { category: "regional-hi", label: "ICON-EU 7 km", note: "DWD Europa — solide Mittelfrist-Basis." },
  117: { category: "regional-hi", label: "ECMWF IFS-HRES 9 km", note: "ECMWF — weltweit führendes Modell, das Rückgrat des Konsens auf mittlere Sicht." },
  21: { category: "regional-hi", label: "WRF 9 km", note: "Windguru-eigenes WRF." },
  3: { category: "global", label: "GFS 13 km", note: "NOAA global — größte Reichweite, gröber, gut für den Trend." },
  45: { category: "global", label: "ICON 13 km", note: "DWD global." },
  59: { category: "global", label: "GDPS 15 km", note: "Environment Canada global." },
};

// Wellen-/Nur-Ozean-Modelle ohne brauchbaren Wind (Gewicht 0) — nicht abrufen.
export const SKIP_MODEL_IDS = new Set<number>([83]);

export function modelInfo(idModel: number, resolution?: number | null): ModelInfo {
  if (MODEL_INFO[idModel]) return MODEL_INFO[idModel];
  const res = resolution ?? 99;
  const category = res <= 3 ? "mesoscale" : res <= 12 ? "regional-hi" : "global";
  return { category, label: `Modell ${idModel}`, note: "Weiteres Windguru-Modell." };
}
