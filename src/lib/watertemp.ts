import "server-only";
import { prisma } from "./prisma";
import { SPOTS } from "./spots";

// Gemessene Wassertemperatur von Rijkswaterstaat (WaterWebservices DDAPI20) — nur LESEN.
//
// Abgerufen und geschrieben wird sie von scripts/ingest_job.py (fetch_water_latest), nicht
// mehr von der App: sonst hängt eine 24/7-Datenquelle am Lebenszyklus der Oberfläche.

const MAX_AGE_H = 72; // älter gilt nicht mehr als „aktuell"

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
