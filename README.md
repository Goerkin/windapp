# Wind Cockpit — Kite-Windprognose für Brouwersdam & Mirns

Ein Wind-Dashboard für Kitesurfer. Es nimmt die Prognosen von bis zu 16 Wettermodellen (frei
abrufbar über Windguru), **korrigiert jedes Modell anhand der echten Messstation am Spot**,
mischt sie nach nachgewiesener Treffsicherheit und zeigt, **wann man wo fahren kann** — mit
kalibrierter Wahrscheinlichkeit.

**Live: <https://windapp-five.vercel.app>**

Erfassung **und** Lernen laufen als Databricks-Jobs, unabhängig von jeder Oberfläche. Die
Next.js-App ist eine reine Leseansicht (gehostet auf Vercel, optional als Databricks App) und
jederzeit entbehrlich — die Datenbasis lernt weiter.

- **Übersicht**: beide Spots, Wind jetzt (gemessen), gemessene Wassertemperatur, nächste
  Fahrfenster und ein Windguru-artiges Kachel-Raster bis zum übernächsten Wochenende
- **Verlauf**: Konsens-Prognose, Böen, Messung, Prognose von vor 24 h, Kurzfrist-Korrektur,
  Fahrfenster, Wahrscheinlichkeit je Stunde
- **Analyse** (`/analyse`): alle Einzelmodelle, Modell-Güte, ehrliche Rückschau, Kalibrierung
- **Hilfe** (`/hilfe`): erklärt die Anzeige und den kompletten Rechenweg mit Formeln — der
  beste Einstieg, um zu verstehen, wie die Zahlen entstehen

Helles und dunkles Thema folgen der System-Einstellung.

Referenz für Schwellen: Twintip, 80 kg (fahrbar ab 13 kn).

## Datenbasis auf Databricks aufsetzen (ein Befehl)

Voraussetzungen: ein Databricks-Account (die **Free Edition** reicht), die
[Databricks CLI](https://docs.databricks.com/dev-tools/cli/install) in aktueller Version (getestet mit v1.12.1) und Node ≥ 20.

```bash
git clone https://github.com/Goerkin/windapp.git && cd windapp
npm install
databricks auth login --host https://<dein-workspace>.cloud.databricks.com --profile wind
node scripts/setup.mjs --profile wind
```

Das Skript ist idempotent (bei Fehlern einfach erneut starten): Lakebase-Datenbank anlegen,
Tabellen + Spots einspielen, Bundle deployen (Erfassungs-Job + Lern-Job), ersten Datenabruf
und ersten Lernlauf starten.

Die Oberfläche ist **nicht** Teil davon — sie läuft auf Vercel (siehe unten). Alternativ als
Databricks App:

```bash
node scripts/setup.mjs --profile wind --with-app   # baut, deployt und startet die App
```

Der erste App-Start dauert ~10–15 min (die CLI zeigt lange „Preparing source code").

> **Free Edition**: nur **ein Lakebase-Projekt** je Account. Existiert schon eins, dessen ID
> übergeben: `node scripts/setup.mjs --profile wind --project <id>`.

Was danach läuft:

| Was | Wann | Wozu |
|---|---|---|
| Erfassungs-Job (`windguru_ingest`) | alle 30 min, 24/7 | Modellprognosen, Messstationen, Wassertemperatur → Lakebase |
| Lern-Job (`windguru_skill`) | stündlich (:10) | Modellgüte + Nachkorrektur neu rechnen, Datenbasis-Wächter |
| App (nur mit `--with-app`) | täglich 6–23 Uhr | Anzeige. Rechnet und schreibt nichts. |

Die Korrekturen werden mit jedem Tag besser; in den ersten Tagen gelten Standardwerte. Der
Lern-Job schreibt am Ende jedes Laufs einen Gesundheitsbericht in die Job-Ausgabe (Alter des
letzten Abrufs, stumme Messstationen, Alter der Wassertemperatur).

Details, Pausieren/Löschen ohne Datenverlust, Troubleshooting: **[DATABRICKS.md](DATABRICKS.md)**.

## Oberfläche auf Vercel

Das GitHub-Repo ist mit Vercel verbunden: **jeder Push auf `master` geht direkt live**, Pull
Requests bekommen eine Preview-URL. Die Region steht in [vercel.json](vercel.json) auf `cle1`
(Cleveland), direkt neben der Lakebase in `us-east-2` — sonst kostet jede Abfrage den Weg über
den Atlantik.

Die App liest Lakebase über einen **eigenen Service Principal mit reinen Leserechten**
(`USAGE` auf das Schema, `SELECT` auf alle Tabellen plus `ALTER DEFAULT PRIVILEGES … GRANT
SELECT`, damit auch künftige Tabellen lesbar sind). Schreiben kann sie nicht — es gibt nur einen
Schreibpfad, die Jobs.

Umgebungsvariablen in Vercel (Production):

| Variable | Wert |
|---|---|
| `WIND_DB` | `lakebase` |
| `DATABRICKS_HOST` | Workspace-URL |
| `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` | OAuth-Secret des Lese-Service-Principals |
| `PGHOST` / `PGDATABASE` | Host des Lakebase-Endpoints / Datenbankname (Standard `databricks_postgres`) |
| `LAKEBASE_PROJECT` / `LAKEBASE_BRANCH` / `LAKEBASE_SCHEMA` | z. B. `windguru` / `production` / `windguru` |

> Das OAuth-Secret eines Service Principals läuft ab (hier: **23.09.2028**). Dann ein neues
> Secret erzeugen und in Vercel eintragen, sonst zeigt die Seite nur noch Verbindungsfehler.

## Qualitätssicherung

[CI](.github/workflows/ci.yml) (GitHub Actions) prüft jeden Push und Pull Request:
Typprüfung, Lint, Tests und Syntax der Python-Jobs. Die Tests decken vor allem ab, dass Lernen
(Python) und Anwenden (TypeScript) dieselbe Mathematik rechnen — sie liegt bewusst doppelt vor,
siehe [CLAUDE.md](CLAUDE.md). Lokal: `npm test` (braucht `python3` mit numpy).

## Wie es funktioniert (kurz)

1. **Daten**: Windguru hat keine offizielle API; die interne `iapi.php` liefert JSON, wenn ein
   `Referer` auf die Spot-Seite mitgeht — alles in [scripts/ingest_job.py](scripts/ingest_job.py).
   Messstationen: Natural High (Windguru) und Mirns NKV (soarcast). Wassertemperatur:
   Rijkswaterstaat (DDAPI20).
2. **Nachkorrektur** je Modell × Vorlauf-Stufe als Ridge-Regression gegen die Messung,
   **gelernt und ehrlich rollierend geprüft** in [scripts/skill_job.py](scripts/skill_job.py)
   (nur Daten VOR dem jeweiligen Prognosezeitpunkt); die Daten wählen zwischen 6 Varianten.
   Angewendet wird das Ergebnis in [src/lib/calib.ts](src/lib/calib.ts).
3. **Konsens** = mit 1/Restfehler² gewichtetes Mittel ([src/lib/consensus.ts](src/lib/consensus.ts)),
   plus Kurzfrist-Korrektur aus der aktuellen Messung.
4. **Kite-Logik** (Richtungen je Spot, Tageslicht, Wahrscheinlichkeit, Fahrfenster):
   [src/lib/kite.ts](src/lib/kite.ts), Spot-Stammdaten in [config/spots.json](config/spots.json).

Ausführlich — mit Formeln, Beispielen und den echten Stellschrauben — auf der
[Hilfe-Seite](https://windapp-five.vercel.app/hilfe).

## Eigene Spots

Spots stehen an genau einer Stelle: [config/spots.json](config/spots.json) (Windguru-ID,
Koordinaten, Windrichtungen, Messstationen, Wassertemperatur-Messstellen). App, Erfassungs-Job
und Seed lesen alle diese Datei. Danach `npm test` (prüft die Form) und
`node scripts/setup.mjs --profile <p> --data-only` (Seed + Job-Deploy).

## Konfiguration der Jobs (Env)

| Variable | Zweck | Standard |
|---|---|---|
| `LAKEBASE_SCHEMA` | Postgres-Schema | `windguru` |
| `SNAPSHOT_RETENTION_DAYS` | Aufbewahrung in Tagen, nur im Erfassungs-Job (`0` = unbegrenzt) | `0` |
| `THIN_AFTER_DAYS` / `THIN_KEEP_H` | Verdichtung älterer Datenstände | `21` / `6` |
| `SKILL_WINDOW_DAYS` | Lernfenster des Lern-Jobs | `90` |
| `SKILL_HALFLIFE_DAYS` | Recency-Halbwertszeit | `14` |
| `SKILL_MAX_SNAPS` | Verifikations-Stichtage (deckelt die Mindest-Stichproben) | `200` |
| `SKILL_NOW` | Stichzeit festnageln (nur reproduzierbare Tests) | – |

API (lesend): `GET /api/dashboard`, `GET /api/status`, `GET /api/model-verify?spot=&day=`.
Es gibt keine schreibende Route mehr — geschrieben wird ausschließlich von den Jobs.

> Privates Projekt, nicht mit Windguru affiliiert. Bitte die Abruffrequenz moderat halten.
