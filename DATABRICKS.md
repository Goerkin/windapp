# Betrieb auf Databricks

Diese App läuft als **Node Databricks App** mit **Lakebase** (Postgres) — modelliert nach
`ai-readiness-app`. Lokal läuft dieselbe Codebasis unverändert gegen eine normale Postgres
(siehe [README.md](README.md)); der Databricks-Modus schaltet sich über Umgebungsvariablen zu.

## Wie der Modus umschaltet

| Signal | Wirkung |
|---|---|
| `WIND_RUNTIME=databricks-app` | Betrieb als Databricks App |
| `WIND_DB=lakebase` **oder** `LAKEBASE_ENDPOINT` gesetzt | DB über den pg-Treiber-Adapter mit Lakebase-Token-Erneuerung ([src/lib/lakebase.ts](src/lib/lakebase.ts)) |

Ist keins gesetzt (lokal), bleibt alles beim normalen Postgres-Pfad (`DATABASE_URL`).

## Automatisierter Datenabruf (24/7-Job)

Die Erfassung läuft **durchgehend als eigener Databricks-Job**, unabhängig vom App-Fenster —
so entsteht auch nachts lückenlos Historie für die Trends. Der Job
([resources/windguru_ingest.job.yml](resources/windguru_ingest.job.yml)) führt alle **30 min**
das serverlose Notebook [scripts/ingest_job.py](scripts/ingest_job.py) aus: es zieht Prognose
+ Live-Stationen von Windguru und schreibt Snapshots/Messungen in dieselbe Lakebase — ein
originalgetreuer Port von [src/lib/windguru.ts](src/lib/windguru.ts) +
[src/lib/ingest.ts](src/lib/ingest.ts).

Der **eingebaute App-Poller ist deshalb aus** (`POLL_ENABLED=0` in [app.yaml](app.yaml)); die
App ([src/instrumentation.ts](src/instrumentation.ts) / [src/lib/poller.ts](src/lib/poller.ts))
ist reiner Leser. So schreibt nicht zusätzlich die App tagsüber doppelt.

Voraussetzungen des Jobs:
- **Serverless-Compute** im Workspace aktiv, und **psycopg2-binary** wird per `%pip` im
  Notebook installiert.
- Der Job muss als eine Identität laufen, die in Lakebase in das Schema **schreiben** darf
  (dieselben Rechte wie der App-Service-Principal). Standard: die deployende Person; sonst
  `run_as` im Job auf den App-SP setzen (Client-ID via `databricks apps get <app>`).

Lokal testbar (ohne Databricks-Auth, gegen die Dev-Postgres):
```bash
DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" LAKEBASE_SCHEMA=public \
  python scripts/ingest_job.py
```

Der HTTP-Weg (`POST /api/ingest` mit `x-ingest-secret`) bleibt für manuelle Anstöße bestehen.

### Live-Messstationen

Zusätzlich zur Prognose zieht jeder Poll die **Live-Messung** einer Windguru-Wetterstation je
Spot (Brouwersdam → *Natural High* 521, Mirns → *Hindeloopen* 16217) über
`q=station_data_current` und legt sie als `StationObs` ab. Die App legt die gemessene Kurve im
Verlaufs-Chart links von „jetzt" gegen die Prognose. Stationszuordnung in
[src/lib/spots.ts](src/lib/spots.ts).

> Bestehende Lakebase-Deployments: einmalig `prisma db push` erneut ausführen, damit die neue
> Tabelle `StationObs` angelegt wird (siehe Bootstrap-Schritt 3).

## Betriebsfenster 6–23 Uhr (Lifecycle-Job)

Die App soll nur **6–23 Uhr (Europe/Berlin)** laufen. Databricks Apps laufen sonst dauerhaft,
deshalb steuern zwei geplante Jobs die Verfügbarkeit
([resources/windguru_lifecycle.job.yml](resources/windguru_lifecycle.job.yml)):

| Job | Zeitplan | Wirkung |
|---|---|---|
| `${app_name} — App-Start` | tgl. 06:00 | `apps.start` |
| `${app_name} — App-Stopp` | tgl. 23:00 | `apps.stop` |

Beide rufen dasselbe Notebook [scripts/app_lifecycle.py](scripts/app_lifecycle.py) auf
(Serverless-Compute, keine Cluster), das über das Databricks-SDK `w.apps.start/stop(name)`
aufruft. Der Poller läuft damit automatisch nur im offenen Fenster.

Voraussetzungen: Serverless-Compute im Workspace aktiv, und der Job läuft als eine
Identität mit **CAN_MANAGE** auf der App (Standard: die deployende Person). Nach dem Deploy
sind die Jobs unter *Workflows* sichtbar und lassen sich dort manuell auslösen/pausieren.

## Dateien (Pendants zu ai-readiness-app)

| Datei | Zweck |
|---|---|
| `app.yaml` | Laufzeitkonfig (Command `node run-app.mjs`, Env, Poller-Intervall) |
| `run-app.mjs` | Startskript: Port aus `DATABRICKS_APP_PORT`, Bindung `0.0.0.0` |
| `databricks.yml` | Asset Bundle (Variablen, Targets `dev`/`prod`) |
| `resources/windguru_app.app.yml` | App-Ressource: Lakebase-`postgres` + Berechtigungen |
| `.databricksignore` | nur der Standalone-Build wandert mit |
| `scripts/lakebase-url.mjs` | erzeugt eine `DATABASE_URL` mit frischem Token für Migrationen |
| `scripts/assemble-standalone.mjs` | vervollständigt den Standalone-Build (static/, .wasm) |

## ⚠️ Build-Schritt (Next.js)

Databricks Apps bauen nicht selbst. Der **Standalone-Build wird lokal (oder in CI) erzeugt
und mitdeployt**:

```bash
npm run build:app     # next build (output: standalone) + static/public + Prisma-.wasm einsammeln
```

Das erzeugt `.next/standalone/server.js`. `run-app.mjs` startet genau diesen Server.

## ⏸ Aktueller Stand: App gelöscht, Datenerfassung läuft (seit 2026-09-21)

Um in der Free Edition Platz für eine andere App zu schaffen, ist die **App gelöscht**. Weiter
läuft (und verliert nichts):

- **Erfassungs-Job** `windguru_ingest` alle 30 min, 24/7 → Modellprognosen, beide Messstationen
  und die Wassertemperatur (Rijkswaterstaat) in Lakebase, **unbegrenzt aufbewahrt**
  (`SNAPSHOT_RETENTION_DAYS=0`, ~2 GB/Jahr).
- Das **Lakebase-Projekt** `windguru` (keine Bundle-Ressource) mit allen Tabellen im Schema
  `windguru`; sie gehören der deployenden Person, nicht dem App-Service-Principal.
- Die **Lifecycle-Jobs** (6/23 Uhr) sind pausiert.

Nicht aktiv, aber beim Wiederaufbau sofort nachgeholt: das Lernen der Korrekturen/Gewichte
(rechnet beim App-Start aus den Rohdaten neu).

Die App-Definition liegt deaktiviert unter `resources/disabled/windguru_app.app.yml`
(`databricks.yml` inkludiert nur `resources/*.yml`) — so legt ein `bundle deploy` (z. B. für
Job-Änderungen) die App nicht versehentlich wieder an.

### App wiederherstellen

```bash
mv resources/disabled/windguru_app.app.yml resources/
# optional Betriebsfenster 6–23 Uhr wieder an: pause_status: UNPAUSED in
# resources/windguru_lifecycle.job.yml
npm run build:app
databricks bundle deploy -t dev -p <profil>        # legt die App + neuen Service Principal an

# Dem NEUEN App-Service-Principal Rechte auf das bestehende Schema geben (als Tabellen-Owner):
SP=$(databricks apps get windguru -p <profil> -o json | jq -r .service_principal_client_id)
export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
export DATABRICKS_TOKEN=$(databricks auth token -p <profil> | jq -r .access_token)
export PGUSER=<deine-mail> LAKEBASE_SCHEMA=windguru
URL="$(node scripts/lakebase-url.mjs | sed -E 's/[?&]schema=[^&]*//')"
docker run --rm postgres:17-alpine psql "$URL" -c "
  GRANT USAGE, CREATE ON SCHEMA windguru TO \"$SP\";
  GRANT ALL ON ALL TABLES IN SCHEMA windguru TO \"$SP\";
  ALTER DEFAULT PRIVILEGES IN SCHEMA windguru GRANT ALL ON TABLES TO \"$SP\";"

databricks bundle run windguru -t dev -p <profil>  # Start (dauert ~10–15 min)
```

Danach ist alles wie vorher — inklusive der zwischenzeitlich gesammelten Historie.

## Bootstrap (einmalig je Workspace)

1. **Lakebase-Projekt/Branch anlegen** (`windguru` / `production`) — Lakebase-Projekte sind
   keine Bundle-Ressource, daher vorab über UI/CLI. Namen müssen zu `databricks.yml` passen.
2. **Schema anlegen** (`windguru`), das der App-Service-Principal besitzt. Der SP entsteht
   beim ersten `bundle deploy`; danach dem SP `CONNECT`/`CREATE` auf dem Schema geben (die
   App-Ressource fordert `CAN_CONNECT_AND_CREATE`).
3. **Schema einspielen** gegen Lakebase (Prisma):
   ```bash
   export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
   export DATABRICKS_TOKEN=<pat>          # oder CLIENT_ID/SECRET des SP
   export LAKEBASE_SCHEMA=windguru
   DATABASE_URL="$(node scripts/lakebase-url.mjs)" npx prisma db push
   # Spots anlegen:
   DATABASE_URL="$(node scripts/lakebase-url.mjs)" npm run seed
   ```

## Deploy

```bash
npm run build:app
databricks bundle deploy -t dev
databricks bundle run windguru -t dev     # bzw. databricks apps deploy / start
```

Nach jedem Deploy setzt DABs die Berechtigungen aus `resources/windguru_app.app.yml` neu.
Weitere Nutzer:innen mit `CAN_USE` dort ergänzen.

> Hinweis: Dieser Node-auf-Apps-Weg ist derselbe wie bei `ai-readiness-app`. Der erste
> Deploy auf eurem Workspace ist der eigentliche Test.
