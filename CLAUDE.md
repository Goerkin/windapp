@AGENTS.md

# Projektleitfaden für Claude

Wind Cockpit: Kite-Windprognose (Brouwersdam & Mirns) als **Databricks App** (Next.js 16 +
React 19 + Prisma 6 mit `engineType = "client"` + Lakebase-Postgres), Datenerfassung als
serverless Databricks-Job (Python). Sprache in UI, Kommentaren und Doku: **Deutsch**.

Nutzerdoku: [README.md](README.md) (Quickstart), [DATABRICKS.md](DATABRICKS.md) (Betrieb,
Troubleshooting), In-App-Hilfe [src/app/hilfe/page.tsx](src/app/hilfe/page.tsx).

## Ersteinrichtung auf einem neuen Workspace

Wenn der Nutzer „deployen/einrichten" will: **`node scripts/setup.mjs --profile <p>`**
(idempotent). Vorher muss es ein angemeldetes CLI-Profil geben
(`databricks auth login --host <url> --profile <p>`) und `npm install` gelaufen sein.
Scheitert `create-project`: Free Edition erlaubt nur ein Lakebase-Projekt je Account →
`--project <vorhandene-id>`. Der erste App-Start dauert 10–15 min — nicht abbrechen, Status per
`databricks apps get windguru -p <p>` prüfen (die CLI zeigt lange „Preparing source code").

## Architektur

| Datei | Rolle |
|---|---|
| `scripts/ingest_job.py` | 24/7-Job (alle 30 min): Windguru-Prognosen, Messstationen, Wassertemperatur → DB. Nutzt **pg8000** (psycopg2 crasht auf Serverless). Verdichtet Daten > 21 Tage auf 1 Stand/6 h. |
| `src/lib/windguru.ts` | Windguru-Client (`iapi.php`, braucht `Referer`), Stationen (Windguru, soarcast) |
| `src/lib/watertemp.ts` | Wassertemperatur von Rijkswaterstaat (DDAPI20) |
| `src/lib/spots.ts` | Spot-Stammdaten: IDs, Koordinaten, Windrichtungs-Sektoren, Stationen, Wasser-Messstellen |
| `src/lib/calib.ts` | Statistisches Modell (framework-neutral): Ridge-MOS je Modell × Vorlauf-Stufe, Varianten, Gewichte 1/σ², Ensemble-Dressing (Wahrscheinlichkeit) |
| `src/lib/skill.ts` | Lernt die Parameter aus der Historie + **rollierende ehrliche Verifikation**, Variantenwahl, Kalibrierung, Nowcast-Gain → `SpotStat.params/verification`. Läuft in der App im Hintergrund (stündlich), nie im Request-Pfad. |
| `src/lib/consensus.ts` | Konsens je Stunde aus korrigierten, gewichteten Modellen |
| `src/lib/data.ts` | Baut das Dashboard-Payload (`SpotPayload`) |
| `src/lib/kite.ts` | Client-Logik: Schwellen (fix Twintip 80 kg), Richtung, Tageslicht, P(≥13 kn), Fahrfenster, Tages-Zusammenfassung |
| `src/components/*` | UI (Recharts). Einstieg `Dashboard.tsx` → `SpotOverview` (+ `ForecastGrid`) → `SpotPanel` |
| `prisma/schema.prisma` | Tabellen: Spot, Snapshot, ModelSeries, StationObs, WaterTemp, ModelSkill, SpotStat |

Spots stehen an **drei Stellen** und müssen synchron sein: `src/lib/spots.ts`,
`scripts/ingest_job.py` (`SPOTS`, `WATER`), `scripts/seed-spots.mjs`.

## Befehle

```bash
npx tsc --noEmit                 # Typprüfung (ESLint-Config ist kaputt, nicht blockierend)
npm run dev                      # lokal gegen Docker-Postgres (siehe README)
npm run build:app                # Standalone-Build für Databricks
databricks bundle validate -t dev -p <p>
databricks bundle deploy  -t dev -p <p>
databricks bundle run windguru        -t dev -p <p>   # App (neu) ausrollen
databricks bundle run windguru_ingest -t dev -p <p>   # Datenabruf sofort
node scripts/setup.mjs --profile <p> --data-only      # Schema-Änderungen nach Lakebase pushen
```

## Arbeitsregeln

- **Vor Next.js-Code** die Doku unter `node_modules/next/dist/docs/` lesen (siehe AGENTS.md) —
  diese Next-Version weicht vom Trainingswissen ab.
- **Schemaänderungen**: `prisma/schema.prisma` ändern → lokal `npx prisma db push` → vor dem
  App-Deploy gegen Lakebase pushen (`setup.mjs --data-only`). Neue Tabellen bekommt der
  App-SP automatisch (DEFAULT PRIVILEGES).
- **Neue Datenquellen**, die 24/7 laufen sollen, gehören in `scripts/ingest_job.py` (die App
  läuft nur 6–23 Uhr). Fehler dort dürfen den Commit der Rohdaten nie verhindern.
- **Lernen/Statistik**: Verifikation immer out-of-sample (nur Daten vor dem Prognosezeitpunkt).
  Wenig Daten → Shrinkage/Standardwerte, keine Overfits. Varianten erst ab genug Vergleichen
  wählen (`SELECT_MIN_N`).
- UI-Farben/Schwellen kommen aus `TH` (kite.ts) und `PALETTE` (palette.ts) — nicht hart codieren.
- Nach UI-Änderungen visuell prüfen (Desktop + ~390 px Handybreite).

## Stolpersteine (bereits gelöst — nicht wieder einbauen)

- Lakebase = PostgreSQL 17; lokale `pg`-Verbindungen brauchen `ssl: { rejectUnauthorized: false }`.
- `databricks database …` ist das ältere Instances-Modell; dieses Projekt nutzt
  **`databricks postgres …`** (Projects/Branches/Endpoints).
- Prisma-URLs enthalten `?schema=`; für `pg`/`pg_dump` diesen Parameter entfernen.
- Der Trend lädt frühere Datenstände per Zeitstempel (nicht „letzte N Snapshots" — bei
  30-min-Takt reicht das nicht bis 7 Tage zurück).
- Recharts: Mess-/Prognosezeilen im selben Datensatz → `connectNulls` an den Linien.
- Hydration-Warnung „vor N min" beim Minutenwechsel ist harmlos (relTime).
