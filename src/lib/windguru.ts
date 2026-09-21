import "server-only";
import { SKIP_MODEL_IDS, type StationDef } from "./spots";

/**
 * Client für die interne Windguru-JSON-API (iapi.php).
 *
 * Es gibt keine offizielle API; die Windguru-Oberfläche selbst spricht mit iapi.php und
 * liefert sauberes JSON, sofern ein `Referer` auf die Spot-Seite mitgeschickt wird (sonst
 * "Unauthorized!"). Kein Headless-Browser nötig.
 *
 * Zwei Aufrufe je Spot:
 *   1. q=forecast_spot → verfügbare Modelle (+ Lauf-Parameter) und die Blend-Definition.
 *   2. q=forecast pro Modell → die Zeitreihe.
 * Die Lauf-Parameter (initstr/rundef) rotieren, deshalb dynamisch aus (1) lesen.
 */

const BASE = "https://www.windguru.cz/int/iapi.php";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Variablen, die wir je Modell übernehmen (alle optional — nicht jedes Modell hat alle).
const SERIES_VARS = [
  "WINDSPD",
  "GUST",
  "WINDDIR",
  "TMP",
  "TMPE",
  "TCDC",
  "HCDC",
  "MCDC",
  "LCDC",
  "APCP1",
  "RH",
  "SLP",
] as const;

export type WgModelArr = {
  id_model: number;
  initstr: string;
  rundef: string;
  cachefix: string;
  period: number;
};

export type WgBlend = {
  model_koef?: Record<string, number>;
  mix_range?: Record<string, number>;
  mix_skip?: string[];
  init_sensitivity?: number;
  res_sensitivity?: number;
};

export type WgSpotMeta = {
  id_spot: number;
  lat?: number;
  lon?: number;
  models: WgModelArr[];
  blend?: WgBlend;
  sunrise?: string;
  sunset?: string;
  waterTemp?: number;
  timezone?: string;
};

export type WgSeries = {
  times: number[]; // Unix-Sekunden
} & Partial<Record<(typeof SERIES_VARS)[number], (number | null)[]>>;

export type WgModelForecast = {
  idModel: number;
  modelName: string;
  modelLongname?: string;
  resolution?: number;
  initStamp: number;
  series: WgSeries;
};

async function getJson(params: Record<string, string | number>, referer: string) {
  const url = `${BASE}?${new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: referer },
    // Serverseitiger Abruf; kein Next-Cache, wir speichern selbst in der DB.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Windguru HTTP ${res.status} für q=${params.q}`);
  const data = await res.json();
  if (data && data.return === "error") {
    throw new Error(`Windguru-Fehler: ${data.message ?? "unbekannt"}`);
  }
  return data;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&deg;/g, "°")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchSpotMeta(idSpot: number): Promise<WgSpotMeta> {
  const data = await getJson(
    { q: "forecast_spot", id_spot: idSpot },
    `https://www.windguru.cz/${idSpot}`,
  );
  const tab = data?.tabs?.[0];
  if (!tab) throw new Error(`forecast_spot: keine tabs für Spot ${idSpot}`);

  const header: string = tab.header ?? "";
  const text = stripTags(header);
  const sun = text.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
  const water = text.match(/(-?\d+(?:\.\d+)?)\s*°\s*C/);
  const tz = text.match(/(CEST|CET|UTC[^ ]*)/);

  return {
    id_spot: idSpot,
    lat: tab.lat,
    lon: tab.lon,
    models: (tab.id_model_arr ?? []) as WgModelArr[],
    blend: tab.blend as WgBlend | undefined,
    sunrise: sun?.[1],
    sunset: sun?.[2],
    waterTemp: water ? Number(water[1]) : undefined,
    timezone: tz?.[1],
  };
}

export async function fetchModelForecast(
  idSpot: number,
  m: WgModelArr,
): Promise<WgModelForecast | null> {
  const data = await getJson(
    {
      q: "forecast",
      id_model: m.id_model,
      rundef: m.rundef,
      initstr: m.initstr,
      id_spot: idSpot,
      cachefix: m.cachefix,
      WGCACHEABLE: 21600,
      ai: 1,
    },
    `https://www.windguru.cz/${idSpot}`,
  );
  const f = data?.fcst;
  const wm = data?.wgmodel;
  if (!f || !Array.isArray(f.hours)) return null;

  const initStamp: number = Number(f.initstamp ?? wm?.initstamp ?? 0);
  const times = (f.hours as number[]).map((h) => initStamp + h * 3600);
  const series: WgSeries = { times };
  for (const v of SERIES_VARS) {
    if (Array.isArray(f[v])) series[v] = f[v] as (number | null)[];
  }
  if (!series.WINDSPD || !series.WINDSPD.some((x) => x != null)) return null;

  return {
    idModel: m.id_model,
    modelName: wm?.model_name ?? f.model_name ?? `Modell ${m.id_model}`,
    modelLongname: wm?.model_longname ?? f.model_longname,
    resolution: wm?.resolution != null ? Number(wm.resolution) : undefined,
    initStamp,
    series,
  };
}

/** Vollständiger Abruf eines Spots: Meta + alle brauchbaren Modelle. */
export async function fetchSpot(idSpot: number): Promise<{
  meta: WgSpotMeta;
  models: WgModelForecast[];
}> {
  const meta = await fetchSpotMeta(idSpot);
  const models: WgModelForecast[] = [];
  for (const m of meta.models) {
    if (SKIP_MODEL_IDS.has(m.id_model)) continue;
    try {
      const mf = await fetchModelForecast(idSpot, m);
      if (mf) models.push(mf);
    } catch {
      // Einzelnes Modell darf ausfallen, ohne den ganzen Abruf zu kippen.
    }
    await new Promise((r) => setTimeout(r, 150)); // höflich zur API
  }
  if (models.length === 0) throw new Error(`Spot ${idSpot}: kein Modell lieferte Wind`);
  return { meta, models };
}

/** Aktuelle Live-Messung einer Windguru-Wetterstation. Wind in Knoten, Richtung in Grad. */
export type WgStationObs = {
  unixtime: number;
  windAvg: number | null;
  windMax: number | null;
  windMin: number | null;
  windDir: number | null;
  temp: number | null;
};

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Zieht den letzten Live-Messwert einer Windguru-Station (q=station_data_current). Braucht
 * denselben Referer-Trick wie der Forecast — hier die Stationsseite. Liefert null, wenn die
 * Station gerade keinen Wert hat.
 */
export async function fetchStationCurrent(idStation: number): Promise<WgStationObs | null> {
  const data = await getJson(
    { q: "station_data_current", id_station: idStation },
    `https://www.windguru.cz/station/${idStation}`,
  );
  const unixtime = num(data?.unixtime);
  if (unixtime == null) return null;
  return {
    unixtime,
    windAvg: num(data.wind_avg),
    windMax: num(data.wind_max),
    windMin: num(data.wind_min),
    windDir: num(data.wind_direction),
    temp: num(data.temperature),
  };
}

// soarcast / NKV-Messnetz: ein Endpunkt liefert die aktuellen Werte aller Stationen. Wind
// steht dort in m/s → in Knoten umrechnen (Basis der App). Braucht Referer/Origin.
const SOARCAST_MARKERS =
  "https://soarcast.nl/sc/scapi.php?table=mv_measurement_location_markers";
const MS_TO_KN = 1.943844;

type SoarcastMarker = {
  location_id: number;
  windsnelheid: number | null; // m/s
  windstoot: number | null; // m/s (Böe)
  windrichting: number | null; // Grad
  oldest_measurement_time: number | null; // Unix-Sekunden
};

export async function fetchSoarcastObs(locationId: number): Promise<WgStationObs | null> {
  const res = await fetch(SOARCAST_MARKERS, {
    headers: {
      "User-Agent": UA,
      Referer: "https://soarcast.nl/web/",
      Origin: "https://soarcast.nl",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`soarcast HTTP ${res.status}`);
  const rows = (await res.json()) as SoarcastMarker[];
  const r = Array.isArray(rows) ? rows.find((x) => x.location_id === locationId) : null;
  if (!r || r.oldest_measurement_time == null) return null;
  const kn = (v: number | null) => (num(v) == null ? null : (num(v) as number) * MS_TO_KN);
  return {
    unixtime: Number(r.oldest_measurement_time),
    windAvg: kn(r.windsnelheid),
    windMax: kn(r.windstoot),
    windMin: null,
    windDir: num(r.windrichting),
    temp: null,
  };
}

/** Aktuelle Messung einer Station — je nach Quelle Windguru oder soarcast/NKV. */
export async function fetchStationObs(def: StationDef): Promise<WgStationObs | null> {
  return def.source === "soarcast"
    ? fetchSoarcastObs(def.id)
    : fetchStationCurrent(def.id);
}
