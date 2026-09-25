#!/usr/bin/env node
/**
 * Umstellung ModelSeries → ModelRun + SnapshotRun (Modell-Reihen nur noch einmal speichern).
 *
 *   node scripts/migrate-runs.mjs                 # übernehmen (idempotent, beliebig oft)
 *   node scripts/migrate-runs.mjs --drop-legacy   # danach: alte Tabelle löschen
 *
 * Braucht DATABASE_URL (für Lakebase via scripts/lakebase-url.mjs) und LAKEBASE_SCHEMA
 * (Standard "public"). Die neuen Tabellen müssen schon existieren (`prisma db push`); setup.mjs
 * ruft dieses Skript direkt danach auf.
 *
 * Übernommene Reihen bekommen als `rundef` "legacy:<md5 der Reihe>": die alte Tabelle kannte
 * Windgurus Laufbeschreibung nicht. Zusammengelegt wird also nur, was Byte für Byte gleich
 * ist — ein Lauf, den Windguru zwischen zwei Abrufen verlängert hat, bleibt zweimal da (wie
 * vorher auch). Die App und der Lern-Job lesen die Reihen eines Abrufs über SnapshotRun und
 * merken davon nichts.
 *
 * Reihenfolge beim Umstieg (Details in DATABRICKS.md):
 *   1. setup.mjs --data-only  → neue Tabellen + dieses Skript
 *   2. Jobs deployen, App pushen (lesen/schreiben ab dann nur noch die neuen Tabellen)
 *   3. dieses Skript noch einmal (holt Abrufe nach, die der alte Job dazwischen schrieb)
 *   4. --drop-legacy, dann ModelSeries aus prisma/schema.prisma entfernen
 */
import pg from "pg";

const schema = process.env.LAKEBASE_SCHEMA || "public";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL fehlt.");
  process.exit(1);
}
const client = new pg.Client({
  connectionString: url.replace(/[?&]sslmode=require/, "").replace(/[?&]schema=[^&]*/, ""),
  ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});
const q = (sql, params) => client.query(sql.replaceAll("§", `"${schema}"`), params);

await client.connect();
try {
  const legacy = (await q(`SELECT to_regclass('§."ModelSeries"') IS NOT NULL AS ok`)).rows[0].ok;
  if (!legacy) {
    console.log("[migrate-runs] keine Tabelle ModelSeries (mehr) — nichts zu tun.");
    process.exit(0);
  }

  if (process.argv.includes("--drop-legacy")) {
    // Nur löschen, wenn JEDER Abruf mit alten Reihen auch Verweise in SnapshotRun hat.
    const missing = (
      await q(`SELECT count(DISTINCT m."snapshotId")::int AS n FROM §."ModelSeries" m
               WHERE NOT EXISTS (SELECT 1 FROM §."SnapshotRun" r WHERE r."snapshotId" = m."snapshotId")`)
    ).rows[0].n;
    if (missing > 0) {
      console.error(`[migrate-runs] ${missing} Abrufe noch nicht übernommen — erst ohne --drop-legacy laufen lassen.`);
      process.exit(1);
    }
    await q(`DROP TABLE §."ModelSeries"`);
    console.log("[migrate-runs] ModelSeries gelöscht. Jetzt das Modell ModelSeries aus prisma/schema.prisma entfernen.");
    process.exit(0);
  }

  await q("BEGIN");
  const runs = await q(`
    INSERT INTO §."ModelRun"
      ("id","spotId","idModel","rundef","modelName","modelLongname","resolution","initStamp","series","firstSeen")
    SELECT DISTINCT ON (s."spotId", m."idModel", md5(m.series::text))
           gen_random_uuid()::text, s."spotId", m."idModel", 'legacy:' || md5(m.series::text),
           m."modelName", m."modelLongname", m.resolution, m."initStamp", m.series, s."fetchedAt"
    FROM §."ModelSeries" m JOIN §."Snapshot" s ON s.id = m."snapshotId"
    ORDER BY s."spotId", m."idModel", md5(m.series::text), s."fetchedAt"
    ON CONFLICT ("spotId","idModel","rundef") DO NOTHING`);
  const links = await q(`
    INSERT INTO §."SnapshotRun" ("snapshotId","runId","koef")
    SELECT m."snapshotId", r.id, m.koef
    FROM §."ModelSeries" m
    JOIN §."Snapshot" s ON s.id = m."snapshotId"
    JOIN §."ModelRun" r ON r."spotId" = s."spotId" AND r."idModel" = m."idModel"
                       AND r.rundef = 'legacy:' || md5(m.series::text)
    ON CONFLICT DO NOTHING`);
  await q("COMMIT");
  const stats = (
    await q(`SELECT (SELECT count(*) FROM §."ModelSeries")::int AS old,
                    (SELECT count(*) FROM §."ModelRun")::int AS runs,
                    (SELECT count(*) FROM §."SnapshotRun")::int AS links`)
  ).rows[0];
  console.log(
    `[migrate-runs] neu: ${runs.rowCount} Reihen, ${links.rowCount} Verweise. ` +
      `Stand: ${stats.old} alte Zeilen → ${stats.runs} Reihen, ${stats.links} Verweise.`,
  );
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await client.end();
}
