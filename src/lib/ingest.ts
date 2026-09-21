import "server-only";
import { prisma } from "./prisma";
import { ensureHostResolved } from "./lakebase";
import { fetchSpot, fetchStationObs } from "./windguru";
import { SPOTS } from "./spots";
import type { Prisma } from "@prisma/client";

/**
 * Ein Datenabruf ("Poll"): holt für jeden Spot alle Modelle von Windguru und legt einen
 * Snapshot mit den Zeitreihen in der DB ab. Danach werden alte Snapshots gepruned.
 * Idempotent genug: wenn der letzte Snapshot jünger als `minAgeMin` ist, wird übersprungen.
 */

// 0 = unbegrenzt aufbewahren (Standard) — Historie für Saisonalitäten.
const RETENTION_DAYS = Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 0);

export async function ensureSpotsSeeded() {
  await ensureHostResolved();
  for (const s of SPOTS) {
    await prisma.spot.upsert({
      where: { id: s.id },
      create: { id: s.id, slug: s.slug, name: s.name, region: s.region, sortOrder: s.sortOrder },
      update: { slug: s.slug, name: s.name, region: s.region, sortOrder: s.sortOrder },
    });
  }
}

export async function ingestSpot(idSpot: number) {
  const { meta, models } = await fetchSpot(idSpot);

  await prisma.snapshot.create({
    data: {
      spotId: idSpot,
      ok: true,
      sunrise: meta.sunrise,
      sunset: meta.sunset,
      waterTemp: meta.waterTemp ?? null,
      timezone: meta.timezone,
      blend: (meta.blend ?? null) as Prisma.InputJsonValue,
      models: {
        create: models.map((m) => ({
          idModel: m.idModel,
          modelName: m.modelName,
          modelLongname: m.modelLongname,
          resolution: m.resolution ?? null,
          koef: meta.blend?.model_koef?.[String(m.idModel)] ?? 1,
          initStamp: m.initStamp,
          series: m.series as unknown as Prisma.InputJsonValue,
        })),
      },
    },
  });

  return { spot: idSpot, models: models.length };
}

/**
 * Zieht die aktuellen Live-Messungen ALLER Stationen eines Spots und legt sie ab (idempotent
 * je Station+Messzeitpunkt). Ohne Stationen: no-op. Eine ausfallende Station kippt die
 * anderen nicht.
 */
export async function ingestStation(idSpot: number): Promise<{ stored: number } | null> {
  const spot = SPOTS.find((s) => s.id === idSpot);
  if (!spot?.stations?.length) return null;
  let stored = 0;
  for (const st of spot.stations) {
    try {
      const obs = await fetchStationObs(st);
      if (!obs) continue;
      const obsTime = new Date(obs.unixtime * 1000);
      await prisma.stationObs.upsert({
        where: { spotId_stationId_obsTime: { spotId: idSpot, stationId: st.id, obsTime } },
        create: {
          spotId: idSpot,
          stationId: st.id,
          obsTime,
          windAvg: obs.windAvg,
          windMax: obs.windMax,
          windMin: obs.windMin,
          windDir: obs.windDir,
          temp: obs.temp,
        },
        update: {
          windAvg: obs.windAvg,
          windMax: obs.windMax,
          windMin: obs.windMin,
          windDir: obs.windDir,
          temp: obs.temp,
        },
      });
      stored++;
    } catch {
      /* einzelne Station darf ausfallen */
    }
  }
  return { stored };
}

async function lastSnapshotAgeMin(idSpot: number): Promise<number | null> {
  const last = await prisma.snapshot.findFirst({
    where: { spotId: idSpot, ok: true },
    orderBy: { fetchedAt: "desc" },
    select: { fetchedAt: true },
  });
  if (!last) return null;
  return (Date.now() - last.fetchedAt.getTime()) / 60000;
}

export async function prune() {
  if (!(RETENTION_DAYS > 0)) return;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
  await prisma.snapshot.deleteMany({ where: { fetchedAt: { lt: cutoff } } });
  await prisma.stationObs.deleteMany({ where: { obsTime: { lt: cutoff } } });
}

/**
 * Führt einen Poll für alle Spots aus. `minAgeMin`: nur abrufen, wenn der letzte Snapshot
 * älter ist (verhindert Doppelabrufe bei Neustart/mehreren Aufrufen).
 */
export async function ingestAll(opts: { minAgeMin?: number } = {}) {
  await ensureSpotsSeeded();
  const results: {
    spot: number;
    models?: number;
    skipped?: boolean;
    obs?: number;
    error?: string;
  }[] = [];

  for (const s of SPOTS) {
    // Live-Messungen immer holen (unabhängig vom Forecast-Intervall) — der
    // "gemessen jetzt"-Wert gegen die Prognose.
    let obs: number | undefined;
    try {
      const r = await ingestStation(s.id);
      if (r) obs = r.stored;
    } catch {
      /* Stationsfehler nicht fatal — Forecast trotzdem versuchen. */
    }

    try {
      if (opts.minAgeMin != null) {
        const age = await lastSnapshotAgeMin(s.id);
        if (age != null && age < opts.minAgeMin) {
          results.push({ spot: s.id, skipped: true, obs });
          continue;
        }
      }
      const r = await ingestSpot(s.id);
      results.push({ ...r, obs });
    } catch (e) {
      results.push({ spot: s.id, error: e instanceof Error ? e.message : String(e), obs });
    }
  }

  try {
    await prune();
  } catch {
    /* prune-Fehler nicht fatal */
  }

  // Modell-Güte + Konsens-Verifikation neu materialisieren (Hintergrund, nicht im
  // Request-Pfad des Dashboards). Fehler hier kippen den Abruf nicht.
  try {
    const { recomputeSkill } = await import("./skill");
    await recomputeSkill();
  } catch (e) {
    console.error("[ingest] Skill-Neuberechnung fehlgeschlagen:", e instanceof Error ? e.message : e);
  }

  return { at: new Date().toISOString(), results };
}
