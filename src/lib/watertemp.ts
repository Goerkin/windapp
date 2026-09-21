import "server-only";
import { prisma } from "./prisma";
import { ensureHostResolved } from "./lakebase";
import { SPOTS } from "./spots";

// Gemessene Wassertemperatur von Rijkswaterstaat (WaterWebservices DDAPI20, offen, ohne
// Schlüssel). Je Messstelle der neueste Wert; liefert eine Stelle mehrere Sensoren (z. B.
// zwei Tiefen), wird zum jüngsten Zeitpunkt gemittelt. Alte Archiv-Reihen fallen weg.

const URL =
  "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen";
const REFRESH_H = 6;
const MAX_AGE_H = 72; // älter gilt nicht mehr als „aktuell"

type Obs = { code: string; obsTime: Date; value: number };

type RwsResponse = {
  Succesvol?: boolean;
  WaarnemingenLijst?: {
    Locatie: { Code: string };
    MetingenLijst: { Tijdstip: string; Meetwaarde: { Waarde_Numeriek: number | null } }[];
  }[];
};

export async function fetchLatestWaterTemps(codes: string[]): Promise<Obs[]> {
  if (!codes.length) return [];
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      LocatieLijst: codes.map((Code) => ({ Code })),
      AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Compartiment: { Code: "OW" }, Grootheid: { Code: "T" } } }],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Rijkswaterstaat HTTP ${res.status}`);
  const data = (await res.json()) as RwsResponse;

  // Je Stelle: alle Messungen sammeln, jüngsten Zeitpunkt nehmen, dort mitteln.
  const byCode = new Map<string, { t: number; v: number }[]>();
  for (const w of data.WaarnemingenLijst ?? []) {
    for (const m of w.MetingenLijst ?? []) {
      const v = m.Meetwaarde?.Waarde_Numeriek;
      const t = Date.parse(m.Tijdstip);
      if (v == null || !Number.isFinite(t) || v < -5 || v > 35) continue;
      const arr = byCode.get(w.Locatie.Code) ?? [];
      arr.push({ t, v });
      byCode.set(w.Locatie.Code, arr);
    }
  }
  const out: Obs[] = [];
  for (const [code, arr] of byCode) {
    const tMax = Math.max(...arr.map((x) => x.t));
    const at = arr.filter((x) => x.t === tMax);
    out.push({ code, obsTime: new Date(tMax), value: Math.round((at.reduce((s, x) => s + x.v, 0) / at.length) * 10) / 10 });
  }
  return out;
}

/** Holt die aktuellen Werte aller Spots und speichert sie (idempotent je Stelle+Zeitpunkt). */
export async function refreshWaterTemps(): Promise<number> {
  await ensureHostResolved();
  const codeToSpot = new Map<string, number>();
  for (const s of SPOTS) for (const w of s.water ?? []) codeToSpot.set(w.code, s.id);
  const obs = await fetchLatestWaterTemps([...codeToSpot.keys()]);
  for (const o of obs) {
    const spotId = codeToSpot.get(o.code);
    if (spotId == null) continue;
    await prisma.waterTemp.upsert({
      where: { code_obsTime: { code: o.code, obsTime: o.obsTime } },
      create: { spotId, code: o.code, obsTime: o.obsTime, value: o.value },
      update: { value: o.value },
    });
  }
  return obs.length;
}

/** Startet den Abruf beim App-Start und dann alle 6 h (auf Databricks läuft die App 6–23 Uhr). */
export function startWaterRefresher() {
  const g = globalThis as unknown as { __wgWaterStarted?: boolean };
  if (g.__wgWaterStarted) return;
  g.__wgWaterStarted = true;
  const run = (reason: string) =>
    refreshWaterTemps()
      .then((n) => console.log(`[water] ${n} Messstellen aktualisiert (${reason})`))
      .catch((e) => console.error("[water] Fehler:", e instanceof Error ? e.message : e));
  setTimeout(() => void run("start"), 5000);
  setInterval(() => void run("intervall"), REFRESH_H * 3600 * 1000);
}

export type WaterReading = { code: string; name: string; value: number; obsTime: string };

/** Aktuelle Werte je Messstelle eines Spots (Reihenfolge wie in spots.ts, Referenz zuerst). */
export async function loadWaterTemps(spotId: number): Promise<WaterReading[]> {
  const defs = SPOTS.find((s) => s.id === spotId)?.water ?? [];
  if (!defs.length) return [];
  const rows = await prisma.waterTemp.findMany({
    where: { spotId, obsTime: { gte: new Date(Date.now() - MAX_AGE_H * 3600e3) } },
    orderBy: { obsTime: "desc" },
  });
  return defs
    .map((d) => {
      const r = rows.find((x) => x.code === d.code);
      return r ? { code: d.code, name: d.name, value: r.value, obsTime: r.obsTime.toISOString() } : null;
    })
    .filter((x): x is WaterReading => x != null);
}

/**
 * Wassertemperatur der Referenz-Messstelle als Funktion der Zeit (nächster Wert innerhalb
 * ±36 h) — für die Lernstichproben der Nachkorrektur. null = kein Messwert in der Nähe.
 */
export async function waterLookup(spotId: number, since: Date): Promise<(tSec: number) => number | null> {
  const code = SPOTS.find((s) => s.id === spotId)?.water?.[0]?.code;
  if (!code) return () => null;
  const rows = await prisma.waterTemp.findMany({
    where: { code, obsTime: { gte: new Date(since.getTime() - 36 * 3600e3) } },
    orderBy: { obsTime: "asc" },
    select: { obsTime: true, value: true },
  });
  const ts = rows.map((r) => r.obsTime.getTime() / 1000);
  return (t: number) => {
    let best: number | null = null;
    let bestD = 36 * 3600;
    for (let i = 0; i < ts.length; i++) {
      const d = Math.abs(ts[i] - t);
      if (d <= bestD) {
        bestD = d;
        best = rows[i].value;
      }
    }
    return best;
  };
}
