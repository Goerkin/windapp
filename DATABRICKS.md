# Betrieb auf Databricks

Die **Datenbasis** läuft als zwei serverless Jobs auf **Lakebase** (Postgres), gebündelt als
**Databricks Asset Bundle**. Einrichtung in einem Befehl: `node scripts/setup.mjs --profile <p>`
(siehe [README.md](README.md)). Dieses Dokument erklärt, was dabei passiert, wie man den Betrieb
steuert und was schiefgehen kann.

**Die Oberfläche ist nicht Teil des Standard-Deployments.** Erfassung UND Lernen sind Jobs; die
Next.js-App liest nur. Sie kann fehlen, gestoppt oder gelöscht sein, ohne dass die Datenbasis
etwas verliert oder aufhört zu lernen. Das war bis Version 0.1 anders — da lag das Lernen in der
App, und als die App gelöscht wurde, froren Modellgüte und Nachkorrektur ein, während die
Rohdaten weiterliefen.

## Bausteine

### Target `dev` (Vorgabe) — nur Daten

| Ressource | Datei | Aufgabe |
|---|---|---|
| Job „Datenerfassung" | [resources/windguru_ingest.job.yml](resources/windguru_ingest.job.yml) → [scripts/ingest_job.py](scripts/ingest_job.py) | alle 30 min, 24/7: Windguru-Prognosen, Messstationen, Wassertemperatur → Lakebase |
| Job „Lernen" | [resources/windguru_skill.job.yml](resources/windguru_skill.job.yml) → [scripts/skill_job.py](scripts/skill_job.py) | stündlich (:10): Modellgüte + Nachkorrektur neu rechnen (`ModelSkill`/`SpotStat`), Gesundheitsbericht der Datenbasis |
| Lakebase-Projekt `windguru` | *keine Bundle-Ressource* (legt `setup.mjs` per `databricks postgres create-project` an) | Branch `production`, Endpoint `primary`, Schema `windguru` |

### Target `app` — zusätzlich die Oberfläche

| Ressource | Datei | Aufgabe |
|---|---|---|
| App `windguru` | [databricks.yml](databricks.yml) (`targets.app`), [app.yaml](app.yaml) | Anzeige. Rechnet und schreibt **nichts**. |
| Jobs „App-Start/-Stopp" | `targets.app` → [scripts/app_lifecycle.py](scripts/app_lifecycle.py) | App nur 6–23 Uhr (Europe/Berlin) laufen lassen |

Die App-Definition liegt bewusst im Target und nicht unter `resources/*.yml`: solange beides im
Standard-Target lag, hätte jedes `bundle deploy` zum Aktualisieren eines Jobs eine gelöschte App
wieder angelegt.

Variablen in [databricks.yml](databricks.yml): `app_name` (windguru), `lakebase_project`
(windguru), `lakebase_branch` (production), `lakebase_schema` (windguru), `lifecycle_pause`
(UNPAUSED, nur im Target `app`).

## Was `scripts/setup.mjs` macht

1. Prüft Node ≥ 20, CLI und Anmeldung des Profils.
2. Legt das Lakebase-Projekt an, falls es fehlt, und wartet auf den Endpoint.
3. `CREATE SCHEMA windguru`, `prisma db push` (alle Tabellen), Spots eintragen.
4. `databricks bundle deploy` (mit `--with-app` vorher `npm run build:app`: Next.js standalone +
   static + Prisma-.wasm, siehe unten).
5. Nur mit `--with-app`: gibt dem **App-Service-Principal** (entsteht beim ersten Deploy) Rechte
   auf das Schema: `GRANT USAGE, CREATE ON SCHEMA`, `GRANT ALL ON ALL TABLES`,
   `ALTER DEFAULT PRIVILEGES`.
6. Startet einmal den Erfassungs-Job und einmal den Lern-Job (mit `--with-app` danach die App).

Optionen: `--project <id>` (vorhandenes Lakebase-Projekt), `--data-only` (nur Datenbank),
`--with-app` (Oberfläche mit deployen), `--no-start`, `--target prod`.

**Wem gehört was:** Tabellen gehören der Person, die `setup.mjs` ausführt; beide Jobs laufen
ebenfalls als diese Person. Die App liest über ihren eigenen Service Principal mit den Rechten
aus Schritt 5. Deshalb hängen Erfassung und Lernen **nicht** an der App.

## Updates deployen

```bash
databricks bundle deploy -t dev -p <profil>              # Jobs
databricks bundle run windguru_ingest -t dev -p <profil> # Datenabruf sofort
databricks bundle run windguru_skill  -t dev -p <profil> # Lernlauf sofort

# Nur wenn die App als Databricks App betrieben wird:
npm run build:app
databricks bundle deploy -t app -p <profil>
databricks bundle run windguru -t app -p <profil>       # neue App-Version ausrollen (~10–15 min)
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

## Ohne App betreiben (Normalfall)

Das ist die Vorgabe, es ist nichts zu tun: `databricks bundle deploy -t dev` deployt nur die
beiden Jobs. Gab es vorher eine App und die Start-/Stopp-Jobs, entfernt dieses Deploy sie
(Bundle-Ressourcen, die nicht mehr definiert sind, werden abgeräumt) — **die Daten bleiben
vollständig**, und das Lernen läuft weiter, weil es im Job steckt.

Die Oberfläche lokal ansehen, ohne irgendetwas zu deployen:

```bash
npm run mirror   # echte Lakebase-Daten in die lokale Postgres spiegeln (siehe README)
npm run dev
```

**App (wieder) hinzunehmen:** `node scripts/setup.mjs --profile <p> --with-app` — erkennt die
vorhandene Datenbank, legt die App an und gibt dem **neuen** Service Principal die Rechte. Die
zwischenzeitlich gesammelte Historie ist sofort da.

## Datenbasis überwachen

Der Lern-Job hängt an jede Ausgabe einen Gesundheitsbericht je Spot: Alter des letzten
Datenabrufs, Alter je Messstation, Alter der Wassertemperatur, dazu eine Liste `warnungen`
(Abruf > 2 h alt, Station > 6 h stumm, Wassertemperatur > 12 h alt). Ansehen:

```bash
databricks jobs list-runs --job-id <id-von-windguru_skill> --limit 5 -p <p> -o json
```

Eine stumme Messstation ist der gefährlichste stille Fehler des Systems: die Prognose läuft
weiter, aber alles Gelernte altert unbemerkt ein. Dieselbe Warnung steht auch oben auf
`/analyse` in der Oberfläche.

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
| Modellgüte/Varianten ändern sich nie | Sie dürfen erst ab genug Vergleichen: `SELECT_MIN_N` (= 0.6 × `SKILL_MAX_SNAPS`) für die Variantenwahl, `PROB_MIN_N` (= 0.5 × `SKILL_MAX_SNAPS` × 4) für die Wahrscheinlichkeits-Kalibrierung. Erreichte Werte stehen in `SpotStat.verification` (`variants[].leads[].n`, `prob.n`). Die Schwellen sind absichtlich als ANTEIL des Deckels definiert — als freie Zahlen standen sie einmal über dem erreichbaren Maximum und beide Mechanismen liefen nie an. |
| Lern-Job scheitert mit `Tabelle "Spot" ist leer` | `node scripts/setup.mjs --profile <p> --data-only` (schreibt Spots samt `stations`/`waterCodes`) |
| Datei > 10 MB beim Deploy | Prisma nutzt `engineType = "client"` (WASM statt Engine-Binary) — nicht ändern |

## Build-Details

Databricks Apps bauen nicht selbst. `npm run build:app` erzeugt `.next/standalone/server.js`
und kopiert static/, public/ und die Prisma-.wasm hinein
([scripts/assemble-standalone.mjs](scripts/assemble-standalone.mjs)). `sync.include` im Target `app` zwingt diese (gitignorierten) Artefakte ins Deployment;
[.databricksignore](.databricksignore) hält Quellcode und Root-`node_modules` heraus.
[run-app.mjs](run-app.mjs) startet den Server auf `DATABRICKS_APP_PORT`, gebunden an `0.0.0.0`.

Lakebase-Verbindung zur Laufzeit: die Plattform injiziert `PGHOST/PGDATABASE/PGUSER/
LAKEBASE_ENDPOINT`; [src/lib/lakebase.ts](src/lib/lakebase.ts) holt kurzlebige Tokens und
erneuert sie. Lokal schaltet derselbe Code auf `DATABASE_URL` um (Umschaltung über
`WIND_DB=lakebase` bzw. `LAKEBASE_ENDPOINT`).
