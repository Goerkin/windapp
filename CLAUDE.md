@AGENTS.md

# Projektleitfaden für Claude

Wind Cockpit: Kite-Windprognose (Brouwersdam & Mirns). Sprache in UI, Kommentaren und Doku:
**Deutsch**.

**Die Architektur-Entscheidung, die alles andere erklärt**: Datenerfassung UND Lernen laufen
als serverless Databricks-Jobs (Python), nicht in der App. Vorher lag das Lernen in der
Next.js-App (`instrumentation.ts` → `skill.ts`); als die App gelöscht wurde, wuchsen die
Rohdaten weiter, aber Modellgüte und Nachkorrektur froren ein. Die App (Next.js 16 + React 19 +
Prisma 6 mit `engineType = "client"` + Lakebase-Postgres) ist jetzt eine **reine Leseansicht**
und jederzeit entbehrlich. Es gibt genau **einen Schreibpfad** in die DB: die Jobs.

Nutzerdoku: [README.md](README.md) (Quickstart), [DATABRICKS.md](DATABRICKS.md) (Betrieb,
Troubleshooting), In-App-Hilfe [src/app/hilfe/page.tsx](src/app/hilfe/page.tsx).

## Ersteinrichtung auf einem neuen Workspace

Wenn der Nutzer „deployen/einrichten" will: **`node scripts/setup.mjs --profile <p>`**
(idempotent) — das setzt die **Datenbasis** auf (Lakebase + Erfassungs-Job + Lern-Job), OHNE
App. Vorher muss es ein angemeldetes CLI-Profil geben
(`databricks auth login --host <url> --profile <p>`) und `npm install` gelaufen sein.
Scheitert `create-project`: Free Edition erlaubt nur ein Lakebase-Projekt je Account →
`--project <vorhandene-id>`.

Die App ist **Opt-in** (`--with-app`, Bundle-Target `app`) und absichtlich nicht im
Standard-Target: Erfassung und App lagen früher im selben Bundle, ein Deploy zum Aktualisieren
des Jobs hätte die gelöschte App jedes Mal wieder angelegt. Erster App-Start dauert 10–15 min —
nicht abbrechen, Status per `databricks apps get windguru -p <p>` prüfen.

## Architektur

| Datei | Rolle |
|---|---|
| `scripts/ingest_job.py` | 24/7-Job (alle 30 min): Windguru-Prognosen (`iapi.php`, braucht `Referer`), Messstationen, Wassertemperatur → DB. Nutzt **pg8000** (psycopg2 crasht auf Serverless). Verdichtet Daten > 21 Tage auf 1 Stand/6 h. |
| `scripts/skill_job.py` | Stündlicher Job: **das Lernen**. Portierung von calib.ts + consensus.ts + dem früheren skill.ts nach Python/numpy. Schreibt `ModelSkill`/`SpotStat` und gibt einen Gesundheitsbericht der Datenbasis aus. Konfiguration (Spots, Stationen, Wasser-Messstelle) liest er aus der Tabelle `Spot`. |
| `src/lib/watertemp.ts` | Wassertemperatur LESEN (geschrieben wird sie im Erfassungs-Job) |
| `config/spots.json` | **Einzige** Quelle der Spot-Stammdaten: IDs, Koordinaten, Windrichtungs-Sektoren, Stationen, Wasser-Messstellen |
| `src/lib/spots.ts` | Typen zu `config/spots.json` + Modell-Metadaten (`MODEL_INFO`) |
| `src/lib/calib.ts` | Statistisches Modell (framework-neutral): Ridge-MOS je Modell × Vorlauf-Stufe, Varianten, Gewichte 1/σ², Ensemble-Dressing (Wahrscheinlichkeit) |
| `src/lib/skill.ts` | Nur noch **Leser** von `ModelSkill`/`SpotStat`. Gelernt wird in `scripts/skill_job.py`. |
| `src/lib/consensus.ts` | Konsens je Stunde aus korrigierten, gewichteten Modellen |
| `src/lib/data.ts` | Baut das Dashboard-Payload (`SpotPayload`) |
| `src/lib/kite.ts` | Client-Logik: Schwellen (fix Twintip 80 kg), Richtung, Tageslicht, P(≥13 kn), Fahrfenster, Tages-Zusammenfassung |
| `src/components/*` | UI (Recharts). Einstieg `Dashboard.tsx` → `SpotOverview` (+ `ForecastGrid`) → `SpotPanel` (Tabs Verlauf/Tag). Analyse liegt auf eigener Route `/analyse` → `AnalysisView` → `ModelPanel`/`AccuracyPanel`. |
| `prisma/schema.prisma` | Tabellen: Spot, Snapshot, ModelSeries, StationObs, WaterTemp, ModelSkill, SpotStat |

Spots stehen **nur** in `config/spots.json`. Die App (`spots.ts`), der Erfassungs-Job
(`ingest_job.py`, sucht die Datei relativ zum Arbeitsverzeichnis, da Notebooks kein `__file__`
haben) und `seed-spots.mjs` lesen sie. Der Lern-Job liest Stationen und Wasser-Messstelle aus
`Spot.stations`/`Spot.waterCodes`, die der Seed füllt. Nach einer Spot-Änderung also
`node scripts/setup.mjs --profile <p> --data-only` laufen lassen. Die Datei NICHT nach `src/`
legen — `.databricksignore` schließt `src/` aus, der Job fände sie nicht.

**Die Mathematik liegt doppelt vor** — `scripts/skill_job.py` lernt, `src/lib/calib.ts` +
`src/lib/consensus.ts` wenden an. Wer eine Formel ändert, muss BEIDE Seiten ändern.
**`npm test`** prüft das: `tests/parity/` füttert beide Seiten mit denselben (reproduzierbar
zufälligen) Modellläufen inkl. Grenzfällen und vergleicht Stunde für Stunde bis 1e-9 — braucht
nur `python3` + numpy, keine DB. Neue Formel-Teile dort mit abdecken. Zwei Fallen, die beim
Portieren zugeschlagen haben (der Test fängt beide): `np.round` rundet halbe zur geraden Zahl
(JS `Math.round` immer aufwärts — betrifft `quadrant()` bei genau 225°), und Python `round()`
genauso. Für Vergleiche eines ganzen Lernlaufs gegen ein gespeichertes Ergebnis nageln
`SKILL_NOW`, `SKILL_WINDOW_DAYS`, `SKILL_HALFLIFE_DAYS` und `SKILL_MAX_SNAPS` ihn fest.

Die **Hilfe-Seite** erklärt den Rechenweg mit den echten Stellschrauben: TS-Werte importiert
sie direkt, die des Lern-Jobs spiegelt `LEARN` in `calib.ts`. `tests/learn-config.test.ts`
bricht, wenn eine Konstante in `skill_job.py` geändert wird, ohne `LEARN` nachzuziehen — dann
auch den Text der Hilfe prüfen.

**Deploy**: Das Repo ist mit Vercel verbunden — ein Push auf `master` geht sofort live. CI
(`.github/workflows/ci.yml`) prüft tsc, Lint, Tests und die Python-Jobs.

Lokal: Docker-Postgres `windguru-pg` (Port 5433, `.env`), `npx prisma db push && npm run seed`,
Daten per `npm run mirror` (braucht `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `PGUSER`,
`TARGET_URL`) oder die Jobs lokal mit `DATABASE_URL=… LAKEBASE_SCHEMA=public python3 scripts/…`.

## Befehle

```bash
npx tsc --noEmit                 # Typprüfung
npm test                         # Parity Python↔TS + Spot-Konfiguration (braucht python3 + numpy)
npm run lint                     # 0 Fehler erwartet (13 bekannte Warnungen, s. eslint.config.mjs)
npm run dev                      # lokal gegen Docker-Postgres windguru-pg auf Port 5433 (.env)
npm run mirror                   # echte Lakebase-Daten nach lokal spiegeln (nur Lesen → Schreiben lokal)
npm run build:app                # Standalone-Build, nur für das Target „app" nötig

databricks bundle validate -t dev -p <p>
databricks bundle deploy  -t dev -p <p>               # Erfassungs- + Lern-Job (KEINE App)
databricks bundle deploy  -t app -p <p>               # zusätzlich die App
databricks bundle run windguru_ingest -t dev -p <p>   # Datenabruf sofort
databricks bundle run windguru_skill  -t dev -p <p>   # Lernlauf sofort
node scripts/setup.mjs --profile <p> --data-only      # Schema-Änderungen nach Lakebase pushen
```

## Arbeitsregeln

- **Vor Next.js-Code** die Doku unter `node_modules/next/dist/docs/` lesen (siehe AGENTS.md) —
  diese Next-Version weicht vom Trainingswissen ab.
- **Schemaänderungen**: `prisma/schema.prisma` ändern → lokal `npx prisma db push` → vor dem
  App-Deploy gegen Lakebase pushen (`setup.mjs --data-only`). Neue Tabellen bekommt der
  App-SP automatisch (DEFAULT PRIVILEGES).
- **Neue Datenquellen** gehören in `scripts/ingest_job.py`, **neue Auswertungen** in
  `scripts/skill_job.py` — nie in die App. Fehler dort dürfen den Commit der Rohdaten nie
  verhindern.
- **Lernen/Statistik**: Verifikation immer out-of-sample (nur Daten vor dem Prognosezeitpunkt).
  Wenig Daten → Shrinkage/Standardwerte, keine Overfits. Varianten erst ab genug Vergleichen
  wählen (`SELECT_MIN_N`).
- **Farben nie hart codieren.** Schwellen aus `TH` (kite.ts). Farben aus den CSS-Variablen in
  `globals.css` bzw. `ktColor()` (liefert `var(--wg-…)`, kippt mit hell/dunkel). `ktColorHex()`
  nur, wo eine Deckkraft angehängt wird. Achtung: ein SVG-**Präsentationsattribut**
  (`fill="…"`, `stroke="…"`) kann **kein** `var()` auflösen — dort entweder `style={{ fill }}`,
  eine Tailwind-Utility (`className="fill-ink"`) oder eine Regel in `globals.css` benutzen
  (CSS schlägt Präsentationsattribute, so ist das Recharts-Chrome gelöst).
- Nach UI-Änderungen visuell prüfen: Desktop + ~390 px Handybreite, **und hell + dunkel**.

## Stolpersteine (bereits gelöst — nicht wieder einbauen)

- Lakebase = PostgreSQL 17; lokale `pg`-Verbindungen brauchen `ssl: { rejectUnauthorized: false }`.
- `databricks database …` ist das ältere Instances-Modell; dieses Projekt nutzt
  **`databricks postgres …`** (Projects/Branches/Endpoints).
- Prisma-URLs enthalten `?schema=`; für `pg`/`pg_dump` diesen Parameter entfernen.
- Der Trend lädt frühere Datenstände per Zeitstempel (nicht „letzte N Snapshots" — bei
  30-min-Takt reicht das nicht bis 7 Tage zurück).
- Recharts: Mess-/Prognosezeilen im selben Datensatz → `connectNulls` an den Linien.
- Hydration-Warnung „vor N min" beim Minutenwechsel ist harmlos (relTime). Ursache sind
  `Date.now()`-Aufrufe im Render; ESLint meldet das als 12 Warnungen (`react-hooks/purity`).
- Die frühere Aussage „ESLint-Config ist kaputt" war falsch: der `FlatCompat`-Umweg war es.
  `eslint-config-next` 16 exportiert bereits Flat-Config-Arrays und wird direkt importiert.
