# Wind Cockpit — Brouwersdam & Mirns

Ein Dashboard, das die beiden Lieblingsspots **Brouwersdam** und **Mirns** auf einen Blick
zeigt — auf Basis der frei abrufbaren **Windguru**-Modelldaten. Neben dem aktuellen Stand
zeigt es den **Modell-Konsens**, die **Unsicherheit** (Spannweite der Modelle), die
**relevantesten Einzelmodelle** in der Tiefe und die **Entwicklung gegenüber früheren
Datenständen** (Trend).

Technisch modelliert nach `ai-readiness-app`: **Next.js 16 + React 19 + Prisma
(engineType „client") + Lakebase (Postgres)**, betrieben als **Databricks App**. Lokal läuft
dieselbe Codebasis gegen eine normale Postgres.

## Wie es funktioniert

- **Datenquelle:** Windguru hat keine offizielle API, aber die eigene Oberfläche spricht mit
  `iapi.php` und liefert sauberes JSON, wenn ein `Referer` auf die Spot-Seite mitgeschickt
  wird. Kein Headless-Browser/Scraper nötig. Siehe [src/lib/windguru.ts](src/lib/windguru.ts).
- **Aggregierter Forecast (Konsens):** Der „WG"-Aggregatforecast von Windguru ist kein
  eigenes Modell, sondern wird aus den Einzelmodellen gemischt. Wir bilden das transparent
  nach: ein je Stunde gewichtetes Mittel über alle Modelle, gewichtet nach **Auflösung**
  (feiner = wichtiger für die Küste), **Aktualität** des Laufs und den Windguru-
  **Mischkoeffizienten**. Dazu ein Band aus der Modell-Spannweite. Siehe
  [src/lib/consensus.ts](src/lib/consensus.ts).
- **Trend/Historie:** Windguru liefert keine Vergangenheit. Ein **Hintergrund-Poller**
  ([src/lib/poller.ts](src/lib/poller.ts)) zieht die Daten im Intervall und legt Snapshots
  ab; daraus wird die Forecast-Entwicklung berechnet.
- **Relevanteste Modelle:** In der Tiefe zeigt das Dashboard u. a. HARMONIE-NL 2 km (KNMI —
  Referenz für die NL-Küste), AROME 1.3 km, ICON-D2 2.2 km, UKV 2 km und ECMWF IFS-HRES 9 km,
  jeweils mit Gewicht und kurzer Einordnung.

## Lokal starten

Voraussetzung: Node 20+ und eine Postgres (z. B. per Docker).

```bash
# 1) Postgres (Beispiel: Docker-Container auf Port 5433)
docker run -d --name windguru-pg \
  -e POSTGRES_USER=windguru -e POSTGRES_PASSWORD=windguru -e POSTGRES_DB=windguru \
  -p 5433:5432 postgres:16

# 2) .env anlegen (siehe .env.example) mit passender DATABASE_URL

# 3) Abhängigkeiten + DB-Schema
npm install
npm run db:generate          # Prisma-Client erzeugen
npm run db:push              # Schema in die DB spielen (Dev)
npm run seed                 # Spots anlegen (Brouwersdam, Mirns)

# 4) Starten — der Poller ruft kurz nach dem Start automatisch ab
npm run dev                  # http://localhost:3000
# optional: sofortigen Abruf erzwingen (zweites Terminal)
npm run ingest
```

## Konfiguration (Env)

| Variable | Zweck | Standard |
|---|---|---|
| `DATABASE_URL` | Postgres-Verbindung (lokal) | – |
| `POLL_ENABLED` | Hintergrund-Poller an/aus | `1` |
| `POLL_INTERVAL_MIN` | Abrufintervall in Minuten | `120` |
| `SNAPSHOT_RETENTION_DAYS` | Aufbewahrung der Snapshots in Tagen (`0` = unbegrenzt) | `0` |
| `INGEST_SECRET` | schützt `POST /api/ingest` (Header `x-ingest-secret`) | – |

## API-Routen

- `GET /api/dashboard` — komplettes Payload (beide Spots: Konsens, Modelle, Trend)
- `GET /api/status` — Poller-Status, Snapshot-Zahlen
- `POST /api/ingest?force=1` — Datenabruf auslösen (optional per `INGEST_SECRET` geschützt)

## Betrieb auf Databricks

Siehe [DATABRICKS.md](DATABRICKS.md). Kurz: `npm run build:app`, dann
`databricks bundle deploy`. Die App läuft als Node-Databricks-App gegen Lakebase; der
Poller automatisiert den Datenabruf ohne separaten Job.

> Privates Dashboard, nicht mit Windguru affiliiert. Bitte die Abruffrequenz moderat halten.
