# Wind Cockpit — Kite-Windprognose für Brouwersdam & Mirns

Ein Wind-Dashboard für Kitesurfer, das als **Databricks App** läuft. Es nimmt die Prognosen
von bis zu 16 Wettermodellen (frei abrufbar über Windguru), **korrigiert jedes Modell anhand
der echten Messstation am Spot**, mischt sie nach nachgewiesener Treffsicherheit und zeigt,
**wann man wo fahren kann** — mit kalibrierter Wahrscheinlichkeit.

- **Übersicht**: beide Spots, Wind jetzt (gemessen), gemessene Wassertemperatur, nächste
  Fahrfenster und ein Windguru-artiges Kachel-Raster bis zum übernächsten Wochenende
- **Verlauf**: Konsens-Prognose, Böen, Messung, Prognose von vor 24 h, Kurzfrist-Korrektur,
  Fahrfenster, Wahrscheinlichkeit je Stunde
- **Analyse**: alle Einzelmodelle, Modell-Güte, ehrliche Rückschau, Kalibrierung
- **Hilfe** (`/hilfe`): erklärt Anzeige und Rechenweg schematisch

Referenz für Schwellen: Twintip, 80 kg (fahrbar ab 13 kn).

## Auf Databricks deployen (ein Befehl)

Voraussetzungen: ein Databricks-Account (die **Free Edition** reicht), die
[Databricks CLI](https://docs.databricks.com/dev-tools/cli/install) in aktueller Version (getestet mit v1.12.1) und Node ≥ 20.

```bash
git clone https://github.com/Goerkin/windapp.git && cd windapp
npm install
databricks auth login --host https://<dein-workspace>.cloud.databricks.com --profile wind
node scripts/setup.mjs --profile wind
```

Das Skript ist idempotent (bei Fehlern einfach erneut starten) und erledigt alles:
Lakebase-Datenbank anlegen, Tabellen + Spots einspielen, App bauen, Bundle deployen
(App + Datenerfassungs-Job + Start/Stopp-Jobs), Datenbankrechte für die App setzen, ersten
Datenabruf und App-Start. Der erste App-Start dauert ~10–15 min. Danach zeigt es die App-URL.

> **Free Edition**: nur **ein Lakebase-Projekt** je Account. Existiert schon eins, dessen ID
> übergeben: `node scripts/setup.mjs --profile wind --project <id>`.

Was danach läuft:

| Was | Wann | Wozu |
|---|---|---|
| Datenerfassungs-Job | alle 30 min, 24/7 | Modellprognosen, Messstationen, Wassertemperatur → Lakebase |
| App | täglich 6–23 Uhr (Start/Stopp-Jobs) | Anzeige; lernt stündlich Korrekturen/Gewichte aus der Historie |

Die Korrekturen werden mit jedem Tag besser; in den ersten Tagen gelten Standardwerte.

Details, Pausieren/Löschen ohne Datenverlust, Troubleshooting: **[DATABRICKS.md](DATABRICKS.md)**.

## Lokal entwickeln

```bash
docker run -d --name windguru-pg -e POSTGRES_USER=windguru -e POSTGRES_PASSWORD=windguru \
  -e POSTGRES_DB=windguru -p 5433:5432 postgres:16
cp .env.example .env            # DATABASE_URL auf die Docker-Postgres
npm install
npx prisma db push && npm run seed
npm run dev                     # http://localhost:3000 — der eingebaute Poller holt Daten
```

`npm run ingest` erzwingt einen sofortigen Abruf. `npx tsc --noEmit` prüft die Typen.

## Wie es funktioniert (kurz)

1. **Daten**: Windguru hat keine offizielle API; die interne `iapi.php` liefert JSON, wenn ein
   `Referer` auf die Spot-Seite mitgeht ([src/lib/windguru.ts](src/lib/windguru.ts)).
   Messstationen: Natural High (Windguru) und Mirns NKV (soarcast). Wassertemperatur:
   Rijkswaterstaat WaterWebservices ([src/lib/watertemp.ts](src/lib/watertemp.ts)).
2. **Nachkorrektur** je Modell × Vorlauf-Stufe als Ridge-Regression gegen die Messung
   ([src/lib/calib.ts](src/lib/calib.ts)), **gelernt und ehrlich rollierend geprüft** in
   [src/lib/skill.ts](src/lib/skill.ts); die Daten wählen zwischen 6 Varianten.
3. **Konsens** = mit 1/Restfehler² gewichtetes Mittel ([src/lib/consensus.ts](src/lib/consensus.ts)),
   plus Kurzfrist-Korrektur aus der aktuellen Messung.
4. **Kite-Logik** (Richtungen je Spot, Tageslicht, Wahrscheinlichkeit, Fahrfenster):
   [src/lib/kite.ts](src/lib/kite.ts), Spot-Stammdaten in [src/lib/spots.ts](src/lib/spots.ts).

## Eigene Spots

Spots stehen an drei Stellen (bewusst einfach gehalten, bitte synchron halten):
[src/lib/spots.ts](src/lib/spots.ts) (Windguru-ID, Koordinaten, Windrichtungen, Messstationen,
Wassertemperatur-Messstellen), [scripts/ingest_job.py](scripts/ingest_job.py) (`SPOTS`, `WATER`)
und [scripts/seed-spots.mjs](scripts/seed-spots.mjs). Danach `node scripts/setup.mjs` erneut.

## Konfiguration (Env)

| Variable | Zweck | Standard |
|---|---|---|
| `DATABASE_URL` | Postgres lokal | – |
| `POLL_ENABLED` | eingebauter Poller (auf Databricks aus, dort macht es der Job) | `1` |
| `POLL_INTERVAL_MIN` | Abrufintervall des Pollers | `120` |
| `SNAPSHOT_RETENTION_DAYS` | Aufbewahrung in Tagen (`0` = unbegrenzt) | `0` |
| `SKILL_REFRESH_MIN` | Intervall des Neulernens der Korrekturen | `60` |
| `INGEST_SECRET` | schützt `POST /api/ingest` | – |

API: `GET /api/dashboard` (alles), `GET /api/status`, `GET /api/model-verify?spot=&day=`,
`POST /api/ingest?force=1`.

> Privates Projekt, nicht mit Windguru affiliiert. Bitte die Abruffrequenz moderat halten.
