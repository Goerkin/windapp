#!/usr/bin/env node
/**
 * Spiegelt die Lakebase-Datenbank in eine lokale Postgres — damit die Oberfläche lokal mit
 * ECHTEN Daten angesehen und weiterentwickelt werden kann, ohne dass eine Databricks App
 * existieren muss.
 *
 * Läuft nur in EINE Richtung (Lakebase → lokal) und leert die Zieltabellen vorher. Das Ziel
 * ist ausdrücklich eine Wegwerf-Kopie; geschrieben wird produktiv nur von den Jobs.
 *
 *   DATABRICKS_HOST=https://<workspace> \
 *   DATABRICKS_TOKEN="$(databricks auth token -p <profil> | jq -r .access_token)" \
 *   PGUSER=<deine-anmeldung> \
 *   TARGET_URL=postgresql://windguru:windguru@localhost:5433/windguru \
 *   node scripts/mirror-from-lakebase.mjs
 *
 * Bequemer: npm run mirror  (siehe package.json / README)
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

// Reihenfolge = Fremdschlüssel-Reihenfolge. ModelSeries hängt an Snapshot, StationObs an Spot.
const TABLES = ["Spot", "Snapshot", "ModelSeries", "StationObs", "WaterTemp", "ModelSkill", "SpotStat"];
const BATCH = 250;

const targetUrl = process.env.TARGET_URL || process.env.DATABASE_URL;
if (!targetUrl) fail("TARGET_URL (oder DATABASE_URL) fehlt — Ziel ist die LOKALE Datenbank.");
if (/databricks|cloud\.databricks/.test(targetUrl)) fail("TARGET_URL zeigt auf Lakebase. Das Ziel muss die lokale DB sein.");

function fail(msg) {
  console.error(`\x1b[31m[mirror] ${msg}\x1b[0m`);
  process.exit(1);
}

const plain = (u) => u.replace(/[?&]sslmode=require/, "").replace(/[?&]schema=[^&]*/, "");

// Quell-URL über den bestehenden Helfer (holt Host + Kurzzeit-Token).
const sourceUrl = execFileSync(process.execPath, ["scripts/lakebase-url.mjs"], { encoding: "utf8" }).trim();
const sourceSchema = process.env.LAKEBASE_SCHEMA || "windguru";
const targetSchema = process.env.TARGET_SCHEMA || "public";

const src = new pg.Client({ connectionString: plain(sourceUrl), ssl: { rejectUnauthorized: false } });
const dst = new pg.Client({ connectionString: plain(targetUrl) });
await src.connect();
await dst.connect();

try {
  // Spalten und Typen der Quelle — die Zieltabellen stammen aus demselben Prisma-Schema.
  const colsOf = async (table) =>
    (
      await src.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [sourceSchema, table],
      )
    ).rows;

  // Erst leeren, in umgekehrter Reihenfolge; CASCADE erledigt die abhängigen Zeilen.
  await dst.query(`TRUNCATE ${TABLES.map((t) => `"${targetSchema}"."${t}"`).join(", ")} CASCADE`);
  console.log("[mirror] Zieltabellen geleert");

  for (const table of TABLES) {
    const cols = await colsOf(table);
    if (!cols.length) {
      console.log(`[mirror] ${table}: in der Quelle nicht vorhanden — übersprungen`);
      continue;
    }
    const names = cols.map((c) => c.column_name);
    // jsonb/json ausdrücklich als Text übergeben und casten: node-pg würde ein JS-Array
    // sonst als Postgres-ARRAY senden (Spot.stations/waterCodes sind Arrays).
    const isJson = cols.map((c) => c.data_type === "jsonb" || c.data_type === "json");
    const quoted = names.map((n) => `"${n}"`).join(", ");

    const rows = (await src.query(`SELECT ${quoted} FROM "${sourceSchema}"."${table}"`)).rows;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      for (const row of chunk) {
        const ph = names.map((n, k) => {
          params.push(isJson[k] && row[n] != null ? JSON.stringify(row[n]) : row[n]);
          return `$${params.length}${isJson[k] ? "::jsonb" : ""}`;
        });
        values.push(`(${ph.join(", ")})`);
      }
      await dst.query(`INSERT INTO "${targetSchema}"."${table}" (${quoted}) VALUES ${values.join(", ")}`, params);
    }
    console.log(`[mirror] ${table}: ${rows.length} Zeilen`);
  }
  console.log("\x1b[32m[mirror] fertig.\x1b[0m");
} finally {
  await src.end();
  await dst.end();
}
