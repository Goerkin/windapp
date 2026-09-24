#!/usr/bin/env node
/**
 * Legt die Spots direkt in der DB an (reines pg, ohne Prisma-Client) — nützlich vor dem
 * ersten Poll und als `prisma db seed`. Nutzt DATABASE_URL; Schema aus LAKEBASE_SCHEMA
 * (Standard "public"). Für Lakebase vorher DATABASE_URL via scripts/lakebase-url.mjs setzen.
 *
 * Schreibt AUSSERDEM die Laufzeit-Konfiguration (Messstationen, Wasser-Messstellen) in die
 * Spalten Spot.stations / Spot.waterCodes. Daraus liest der Lern-Job scripts/skill_job.py
 * seine Konfiguration — er braucht so keine eigene Spot-Tabelle und kann nicht
 * auseinanderlaufen, solange dieser Seed nach einer Änderung an config/spots.json läuft.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";

// Einzige Quelle der Spots: config/spots.json (liest auch App und Erfassungs-Job).
const { spots } = JSON.parse(await readFile(new URL("../config/spots.json", import.meta.url), "utf8"));
const SPOTS = spots.map((s) => ({
  ...s,
  stations: (s.stations ?? []).map(({ id, name, source }) => ({ id, name, source })),
  // Die ERSTE Stelle ist die Referenz für den Schichtungs-Term (Wasser − Luft).
  waterCodes: (s.water ?? []).map((w) => w.code),
}));

const schema = process.env.LAKEBASE_SCHEMA || "public";
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL?.replace(/[?&]sslmode=require/, "").replace(/[?&]schema=[^&]*/, ""),
  // Lakebase verlangt TLS; das Zertifikat ist aus Node heraus nicht immer verifizierbar.
  ssl: process.env.DATABASE_URL?.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

await client.connect();
for (const s of SPOTS) {
  await client.query(
    `INSERT INTO "${schema}"."Spot" (id, slug, name, region, "sortOrder", stations, "waterCodes", "updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (id) DO UPDATE SET slug=$2, name=$3, region=$4, "sortOrder"=$5,
       stations=$6, "waterCodes"=$7, "updatedAt"=now()`,
    [s.id, s.slug, s.name, s.region, s.sortOrder, JSON.stringify(s.stations), JSON.stringify(s.waterCodes)],
  );
  console.log(`[seed] Spot ${s.id} ${s.name} — ${s.stations.length} Station(en), ${s.waterCodes.length} Wasser-Messstelle(n)`);
}
await client.end();
console.log("[seed] fertig.");
