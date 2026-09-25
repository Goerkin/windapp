# Wind Cockpit — Kite-Windprognose für Brouwersdam & Mirns

Ein Wind-Dashboard für Kitesurfer. Es nimmt die Prognosen von bis zu 16 Wettermodellen (frei
abrufbar über Windguru), **korrigiert jedes Modell anhand der echten Messstation am Spot**,
mischt sie nach nachgewiesener Treffsicherheit und zeigt, **wann man wo fahren kann** — mit
kalibrierter Wahrscheinlichkeit.

**Live: <https://windapp-five.vercel.app>**

Erfassung **und** Lernen laufen als Databricks-Jobs, unabhängig von jeder Oberfläche. Die
Next.js-App ist eine reine Leseansicht (gehostet auf Vercel) und jederzeit entbehrlich — die
Datenbasis lernt weiter.

- **Übersicht**: die Antwort zuerst (geht heute/morgen etwas?), je Spot Wind jetzt (gemessen),
  gemessene Wassertemperatur und nächste Fahrfenster, darunter ein gemeinsames Windguru-artiges
  Kachel-Raster für beide Spots bis zum übernächsten Wochenende — Farbe erst dort, wo es fahrbar
  wird
- **Verlauf**: Konsens-Prognose, Böen, Messung, Prognose von vor 24 h, Kurzfrist-Korrektur,
  Fahrfenster, Wahrscheinlichkeit je Stunde
- **Analyse** (`/analyse`): alle Einzelmodelle, die Aufschlüsselung jeder Konsens-Stunde
  (Rohwert, Korrektur, Anteil je Modell — und welche Modelle warum fehlen), die gelernten
  Korrekturen je Modell/Vorlauf/Windrichtung, Modell-Güte, ehrliche Rückschau, Kalibrierung
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

Die Oberfläche ist **nicht** Teil davon — sie läuft auf Vercel (siehe unten).

> **Free Edition**: nur **ein Lakebase-Projekt** je Account. Existiert schon eins, dessen ID
> übergeben: `node scripts/setup.mjs --profile wind --project <id>`.

Was danach läuft:

| Was | Wann | Wozu |
|---|---|---|
| Erfassungs-Job (`windguru_ingest`) | alle 30 min, 24/7 | Modellprognosen, Messstationen, Wassertemperatur → Lakebase |
| Lern-Job (`windguru_skill`) | stündlich (:10) | Modellgüte + Nachkorrektur neu rechnen, Datenbasis-Wächter |

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

## Aufs Handy holen

Die Oberfläche ist eine **installierbare Web-App (PWA)**. Im Browser die Seite öffnen, dann:

- **iPhone (Safari):** Teilen-Symbol → *Zum Home-Bildschirm*
- **Android (Chrome):** Menü ⋮ → *App installieren*

Danach startet sie wie eine native App im Vollbild, ohne Browserleiste, mit eigenem Symbol. Ein
App-Store ist nicht beteiligt — ein Push auf `master` aktualisiert auch die installierte App.

Zwei Dinge sind eigens dafür gebaut, weil eine Homescreen-App anders benutzt wird als ein Tab:

- **Ohne Netz** zeigt sie den zuletzt geladenen Stand statt einer Fehlerseite
  ([public/sw.js](public/sw.js)) — am Wasser ist der Empfang oft schlecht. Wie alt der Stand
  ist, steht ohnehin im Kopf der Seite und wird ab 45 Minuten gelb.
- **Beim Aufklappen** lädt sie sofort nach. Eine installierte App wird nicht neu geladen,
  sondern aus dem Hintergrund geweckt; das 10-Minuten-Intervall stand solange still.

**Updates kommen von allein.** Ein Push auf `master` erreicht auch die installierte App: HTML
und Daten holt der Service Worker immer zuerst aus dem Netz, und die JavaScript-Dateien tragen
den Inhalt im Namen — nach einem Deploy verweist die frische Seite auf neue Namen, die der
Cache nicht hat. Es gibt nichts zu deinstallieren. Zwei Einschränkungen: offline bleibt es beim
alten Stand, und eine bereits offene App aktualisiert ihre Oberfläche erst beim nächsten Öffnen
(der 10-Minuten-Takt holt nur Daten, keinen Code).

Auch ein geänderter `public/sw.js` installiert sich selbst — dafür ist kein Handgriff nötig.
`VERSION` steuert nur, ob die **alten Caches verworfen** werden; das greift, wie jede
SW-Änderung, erst beim übernächsten Öffnen (einmal Entdecken, einmal Übernehmen). Wer also die
Caching-Regeln ändert, zählt `VERSION` hoch, damit kein Altbestand liegen bleibt.

Die Symbole liegen eingecheckt in `public/`. Nach einer Änderung am Logo erzeugt
`node scripts/make-icons.mjs` sie neu (braucht `sharp`, nur lokal — der Build selbst rechnet
keine Bilder).

## Qualitätssicherung

[CI](.github/workflows/ci.yml) (GitHub Actions) prüft jeden Push und Pull Request:
Typprüfung, Lint, Tests und beide Python-Jobs. Die Tests decken vor allem ab, dass Lernen
(Python) und Anwenden (TypeScript) dieselbe Mathematik rechnen — sie liegt bewusst doppelt vor,
siehe [CLAUDE.md](CLAUDE.md). Lokal: `npm test` (braucht `python3` mit numpy).

Ein zweiter CI-Job lässt **beide Jobs gegen ein echtes Postgres** laufen
([tests/jobs/e2e_test.py](tests/jobs/e2e_test.py)): Erfassung ohne Netz (Abrufe ersetzt) und
Lernen auf synthetischen Läufen mit bekanntem Fehler, den das Lernen wiederfinden muss. Lokal:
`TEST_DATABASE_URL=postgresql://…/windguru npm run test:jobs` (legt nur das Schema `e2e_jobs`
an und verwirft es bei jedem Lauf).

> Vercel deployt einen Push auf `master` **parallel** zur CI — ein roter Lauf hält ihn nicht
> auf. Wer das will: in Vercel unter *Settings → Git* das automatische Deployment von `master`
> abschalten oder über Pull Requests arbeiten (dort blockiert die Branch-Regel das Mergen).

## Wie es funktioniert (kurz)

1. **Daten**: Windguru hat keine offizielle API; die interne `iapi.php` liefert JSON, wenn ein
   `Referer` auf die Spot-Seite mitgeht — alles in [scripts/ingest_job.py](scripts/ingest_job.py).
   Jede Modell-Reihe wird **genau einmal** gespeichert (Schlüssel: Windgurus `rundef`); eine
   schon bekannte Reihe wird gar nicht erst neu heruntergeladen. Messstationen: Natural High
   (Windguru, 10-min-Verlauf der letzten Stunden bei jedem Lauf — Lücken füllen sich selbst) und
   Mirns NKV (soarcast, nur der aktuelle Wert). Wassertemperatur: Rijkswaterstaat (DDAPI20).
2. **Nachkorrektur** je Modell × Vorlauf-Stufe als Ridge-Regression gegen die Messung,
   **gelernt und ehrlich rollierend geprüft** in [scripts/skill_job.py](scripts/skill_job.py)
   (nur Daten VOR dem jeweiligen Prognosezeitpunkt); die Daten wählen zwischen 6 Varianten. Die
   berichtete Güte ist die der jeweils **damals** gewählten Variante — keine Auswahl-Schönung.
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
| `THIN_AFTER_DAYS` / `THIN_KEEP_H` | Verdichtung älterer Abrufe (verwaiste Modell-Reihen fallen mit weg) | `21` / `6` |
| `STATION_BACKFILL_H` | so viele Stunden Stationsverlauf holt jeder Erfassungslauf nach | `6` |
| `SKILL_WINDOW_DAYS` | Lernfenster des Lern-Jobs | `90` |
| `SKILL_HALFLIFE_DAYS` | Recency-Halbwertszeit | `14` |
| `SKILL_MAX_SNAPS` | Verifikations-Stichtage (deckelt die Mindest-Stichproben) | `200` |
| `SKILL_NOW` | Stichzeit festnageln (nur reproduzierbare Tests) | – |

API (lesend): `GET /api/dashboard`, `GET /api/status`, `GET /api/model-verify?spot=&day=`.
Es gibt keine schreibende Route mehr — geschrieben wird ausschließlich von den Jobs.

> Privates Projekt, nicht mit Windguru affiliiert. Bitte die Abruffrequenz moderat halten.
