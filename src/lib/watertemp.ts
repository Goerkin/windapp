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
