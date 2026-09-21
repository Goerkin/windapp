# Betrieb auf Databricks

Die App läuft als **Node Databricks App** mit **Lakebase** (Postgres), gebündelt als
**Databricks Asset Bundle**. Einrichtung in einem Befehl: `node scripts/setup.mjs --profile <p>`
(siehe [README.md](README.md)). Dieses Dokument erklärt, was dabei passiert, wie man den Betrieb
steuert und was schiefgehen kann.

## Bausteine

| Ressource | Datei | Aufgabe |
|---|---|---|
| App `windguru` | [resources/windguru_app.app.yml](resources/windguru_app.app.yml), [app.yaml](app.yaml) | Anzeige; lernt im Hintergrund stündlich Korrekturen/Gewichte ([src/lib/skill.ts](src/lib/skill.ts)) und holt alle 6 h die Wassertemperatur |
| Job „Datenerfassung" | [resources/windguru_ingest.job.yml](resources/windguru_ingest.job.yml) → [scripts/ingest_job.py](scripts/ingest_job.py) | alle 30 min, 24/7: Windguru-Prognosen, Messstationen, Wassertemperatur → Lakebase |
| Jobs „App-Start/-Stopp" | [resources/windguru_lifecycle.job.yml](resources/windguru_lifecycle.job.yml) → [scripts/app_lifecycle.py](scripts/app_lifecycle.py) | App nur 6–23 Uhr (Europe/Berlin) laufen lassen |
| Lakebase-Projekt `windguru` | *keine Bundle-Ressource* (legt `setup.mjs` per `databricks postgres create-project` an) | Branch `production`, Endpoint `primary`, Schema `windguru` |

Variablen in [databricks.yml](databricks.yml): `app_name` (windguru), `lakebase_project`
(windguru), `lakebase_branch` (production), `lakebase_schema` (windguru), `lifecycle_pause`
(UNPAUSED).

## Was `scripts/setup.mjs` macht

1. Prüft Node ≥ 20, CLI und Anmeldung des Profils.
2. Legt das Lakebase-Projekt an, falls es fehlt, und wartet auf den Endpoint.
3. `CREATE SCHEMA windguru`, `prisma db push` (alle Tabellen), Spots eintragen.
4. `npm run build:app` (Next.js standalone + static + Prisma-.wasm, siehe unten) und
   `databricks bundle deploy`.
5. Gibt dem **App-Service-Principal** (entsteht beim ersten Deploy) Rechte auf das Schema:
   `GRANT USAGE, CREATE ON SCHEMA`, `GRANT ALL ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES`.
6. Startet einmal den Erfassungs-Job und dann die App (`databricks bundle run windguru`).

Optionen: `--project <id>` (vorhandenes Lakebase-Projekt), `--data-only` (nur Datenbank),
`--no-start`, `--target prod`.

**Wem gehört was:** Tabellen gehören der Person, die `setup.mjs` ausführt; der Erfassungs-Job
läuft ebenfalls als diese Person. Die App liest/schreibt über ihren Service Principal mit den
Rechten aus Schritt 5. Deshalb hängt die Datenerfassung **nicht** an der App.

## Updates deployen

```bash
npm run build:app
databricks bundle deploy -t dev -p <profil>
databricks bundle run windguru -t dev -p <profil>   # neue App-Version ausrollen (~10–15 min)
```

Bei Schemaänderungen (`prisma/schema.prisma`) vorher gegen Lakebase pushen — am einfachsten
`node scripts/setup.mjs --profile <p> --data-only`.

## Datenhaltung & Speicher

- **Aufbewahrung unbegrenzt** (`SNAPSHOT_RETENTION_DAYS=0`) — für Saisonalitäten.
- **Verdichtung** im Job: älter als 21 Tage bleibt nur ein Datenstand je Spot und 6 h
  (`THIN_AFTER_DAYS`, `THIN_KEEP_H`). Grund: Der 30-min-Takt speichert denselben Modelllauf bis
  zu 12×; das Lakebase-Projekt meldet in der Free Edition ein Branch-Limit von 512 MB
  (`branch_logical_size_limit_bytes`). Unverdichtet ≈ 5 MB/Tag, verdichtet ≈ 0.4 MB/Tag.
  Messungen und Wassertemperatur werden nie verdichtet.
- Größe prüfen: `databricks postgres get-project projects/windguru -p <p>` bzw. per SQL
  `pg_total_relation_size`.

## App löschen, Daten weiter sammeln (z. B. Free-Edition-App-Limit)

```bash
mkdir -p resources/disabled && git mv resources/windguru_app.app.yml resources/disabled/
databricks bundle deploy -t dev -p <p> --var lifecycle_pause=PAUSED --auto-approve
```

Das Bundle löscht die App (nur sie), pausiert Start/Stopp-Jobs; der Erfassungs-Job und alle
Daten bleiben. `databricks.yml` inkludiert nur `resources/*.yml`, deshalb legt ein späteres
Deploy die App nicht versehentlich wieder an.

**Wiederherstellen:** Datei zurück nach `resources/`, dann `node scripts/setup.mjs --profile <p>`
— es erkennt die vorhandene Datenbank, legt die App neu an und gibt dem **neuen** Service
Principal die Rechte. Die zwischenzeitlich gesammelte Historie ist sofort da.

## Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| `bundle run windguru` hängt lange bei „Preparing source code" | normal (10–15 min). Status: `databricks apps get windguru -p <p>` → `active_deployment.status.state` |
| App-Log: `permission denied for table …` | Rechte für den App-SP fehlen → `node scripts/setup.mjs` erneut (Schritt 5) |
| `create-project` scheitert | Free Edition: nur ein Lakebase-Projekt je Account → `--project <vorhandene-id>` |
| Job-Fehler beim Import des Postgres-Treibers | Der Job nutzt bewusst `pg8000` (reines Python). `psycopg2-binary` crasht auf Serverless (SIGABRT). |
| Lokale Verbindung zu Lakebase: TLS-Fehler | `ssl: { rejectUnauthorized: false }` (so in `setup.mjs`/`seed-spots.mjs`) |
| `pg_dump` gegen Lakebase: Versionsfehler | Lakebase ist PostgreSQL 17 → `docker run --rm postgres:17-alpine pg_dump …`; `?schema=` aus der URL entfernen |
| App startet, zeigt „Noch keine Daten" | Erfassungs-Job einmal starten: `databricks bundle run windguru_ingest -t dev -p <p>` |
| Datei > 10 MB beim Deploy | Prisma nutzt `engineType = "client"` (WASM statt Engine-Binary) — nicht ändern |

## Build-Details

Databricks Apps bauen nicht selbst. `npm run build:app` erzeugt `.next/standalone/server.js`
und kopiert static/, public/ und die Prisma-.wasm hinein
([scripts/assemble-standalone.mjs](scripts/assemble-standalone.mjs)). `sync.include` in
`databricks.yml` zwingt diese (gitignorierten) Artefakte ins Deployment;
[.databricksignore](.databricksignore) hält Quellcode und Root-`node_modules` heraus.
[run-app.mjs](run-app.mjs) startet den Server auf `DATABRICKS_APP_PORT`, gebunden an `0.0.0.0`.

Lakebase-Verbindung zur Laufzeit: die Plattform injiziert `PGHOST/PGDATABASE/PGUSER/
LAKEBASE_ENDPOINT`; [src/lib/lakebase.ts](src/lib/lakebase.ts) holt kurzlebige Tokens und
erneuert sie. Lokal schaltet derselbe Code auf `DATABASE_URL` um (Umschaltung über
`WIND_DB=lakebase` bzw. `LAKEBASE_ENDPOINT`).
