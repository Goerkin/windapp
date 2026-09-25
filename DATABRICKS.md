# Betrieb auf Databricks

Die **Datenbasis** läuft als zwei serverless Jobs auf **Lakebase** (Postgres), gebündelt als
**Databricks Asset Bundle**. Einrichtung in einem Befehl: `node scripts/setup.mjs --profile <p>`
(siehe [README.md](README.md)). Dieses Dokument erklärt, was dabei passiert, wie man den Betrieb
steuert und was schiefgehen kann.

**Die Oberfläche gehört nicht dazu.** Erfassung UND Lernen sind Jobs; die Next.js-App liest nur
und läuft auf Vercel. Sie kann fehlen, ohne dass die Datenbasis etwas verliert oder aufhört zu
lernen. Das war bis Version 0.1 anders — da lag das Lernen in der App, und als die App gelöscht
wurde, froren Modellgüte und Nachkorrektur ein, während die Rohdaten weiterliefen. (Den früheren
Weg, die App als Databricks App zu betreiben, gibt es nicht mehr; er steht in der Git-Historie.)

## Bausteine

| Ressource | Datei | Aufgabe |
|---|---|---|
| Job „Datenerfassung" | [resources/windguru_ingest.job.yml](resources/windguru_ingest.job.yml) → [scripts/ingest_job.py](scripts/ingest_job.py) | alle 30 min, 24/7: Windguru-Prognosen, Messstationen, Wassertemperatur → Lakebase |
| Job „Lernen" | [resources/windguru_skill.job.yml](resources/windguru_skill.job.yml) → [scripts/skill_job.py](scripts/skill_job.py) | stündlich (:10): Modellgüte + Nachkorrektur neu rechnen (`ModelSkill`/`SpotStat`), Gesundheitsbericht der Datenbasis |
| Lakebase-Projekt `windguru` | *keine Bundle-Ressource* (legt `setup.mjs` per `databricks postgres create-project` an) | Branch `production`, Endpoint `primary`, Schema `windguru` |

Variablen in [databricks.yml](databricks.yml): `app_name` (Namenspräfix der Jobs, windguru),
`lakebase_project` (windguru), `lakebase_branch` (production), `lakebase_schema` (windguru).

## Was `scripts/setup.mjs` macht

1. Prüft Node ≥ 20, CLI und Anmeldung des Profils.
2. Legt das Lakebase-Projekt an, falls es fehlt, und wartet auf den Endpoint.
3. `CREATE SCHEMA windguru`, `prisma db push` (alle Tabellen), `scripts/migrate-runs.mjs`
   (übernimmt Altdaten, s. u.; sonst nichts zu tun), Spots eintragen.
4. `databricks bundle deploy` (die beiden Jobs).
5. Startet einmal den Erfassungs-Job und einmal den Lern-Job.

Optionen: `--project <id>` (vorhandenes Lakebase-Projekt), `--data-only` (nur Datenbank),
`--target prod`.

**Wem gehört was:** Tabellen gehören der Person, die `setup.mjs` ausführt; beide Jobs laufen
ebenfalls als diese Person. Die Vercel-App liest über einen eigenen Service Principal mit reinen
Leserechten (README). Deshalb hängen Erfassung und Lernen **nicht** an der App.

## Updates deployen

```bash
databricks bundle deploy -t dev -p <profil>              # Jobs
databricks bundle run windguru_ingest -t dev -p <profil> # Datenabruf sofort
databricks bundle run windguru_skill  -t dev -p <profil> # Lernlauf sofort
```

Bei Schemaänderungen (`prisma/schema.prisma`) vorher gegen Lakebase pushen — am einfachsten
`node scripts/setup.mjs --profile <p> --data-only`. Neue Tabellen kann der Lese-Service-Principal
der Vercel-App sofort lesen (`ALTER DEFAULT PRIVILEGES … GRANT SELECT`), sofern sie von derselben
Person angelegt werden, die die Default-Rechte gesetzt hat.

## Umstellung ModelSeries → ModelRun (einmalig, 09/2026)

Früher stand jede Modell-Reihe in **jedem** 30-min-Abruf erneut in `ModelSeries` (≈ 7× dieselben
Daten). Jetzt liegt jede Reihe genau einmal in `ModelRun`, und `SnapshotRun` sagt, welcher Abruf
welche Reihen sah. Die Umstellung läuft ohne Datenverlust und ohne Ausfall der App, in dieser
Reihenfolge:

1. `node scripts/setup.mjs --profile <p> --data-only` — legt `ModelRun`/`SnapshotRun` an und
   übernimmt alle vorhandenen Reihen (idempotent; alte App und alter Job laufen unverändert weiter).
2. `databricks bundle deploy -t dev -p <p>` — der Erfassungs-Job schreibt ab jetzt nur noch in die
   neuen Tabellen, der Lern-Job liest sie. Das Deploy räumt dabei auch alte Bundle-Ressourcen ab,
   die nicht mehr definiert sind (z. B. pausierte App-Start/-Stopp-Jobs).
3. Push auf `master` — die Vercel-App liest die neuen Tabellen.
4. `scripts/migrate-runs.mjs` noch einmal laufen lassen (holt Abrufe nach, die der alte Job
   zwischen 1. und 2. schrieb) — z. B. erneut `setup.mjs --data-only`.
5. Wenn alles läuft: `node scripts/migrate-runs.mjs --drop-legacy` (mit `DATABASE_URL` aus
   `scripts/lakebase-url.mjs` und `LAKEBASE_SCHEMA=windguru`) löscht `ModelSeries` — es prüft
   vorher, dass jeder Abruf übernommen ist. Danach das Modell `ModelSeries` (und das Feld
   `Snapshot.models`) aus `prisma/schema.prisma` entfernen, sonst legt der nächste `db push` die
   leere Tabelle wieder an.

## Datenhaltung & Speicher

- **Aufbewahrung unbegrenzt** (`SNAPSHOT_RETENTION_DAYS=0`) — für Saisonalitäten.
- **Jede Modell-Reihe einmal** (`ModelRun`, Schlüssel = Windgurus `rundef`, die Beschreibung,
  aus welchen Läufen die Reihe zusammengesetzt ist). Eine bekannte `rundef` wird nicht neu
  heruntergeladen — nur in den ersten 3 h (`RUN_REFRESH_H`), weil Windguru manche Läufe
  schrittweise verlängert. Das spart auch den Großteil der Windguru-Anfragen.
- **Verdichtung** im Job: älter als 21 Tage bleibt nur ein Abruf je Spot und 6 h
  (`THIN_AFTER_DAYS`, `THIN_KEEP_H`); Reihen, auf die dann kein Abruf mehr verweist, fallen mit
  weg. Das Lernen nutzt ohnehin höchstens einen Lauf je Modell und 6 h. Grund: das Lakebase-Projekt
  meldet in der Free Edition ein Branch-Limit von 512 MB (`branch_logical_size_limit_bytes`).
  Messungen und Wassertemperatur werden nie verdichtet.
- **Messstationen**: Windguru-Stationen liefern 10-min-Mittel; jeder Lauf holt die letzten
  `STATION_BACKFILL_H` (6) Stunden nach und schreibt idempotent — fällt ein Lauf aus, bleibt keine
  Lücke. soarcast (Mirns NKV) bietet keinen Verlauf an: dort ein Wert je Lauf.
- Größe prüfen: `databricks postgres get-project projects/windguru -p <p>` bzw. per SQL
  `pg_total_relation_size`.

Die Oberfläche lokal ansehen, ohne irgendetwas zu deployen:

```bash
npm run mirror   # echte Lakebase-Daten in die lokale Postgres spiegeln (siehe README)
npm run dev
```

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
| `create-project` scheitert | Free Edition: nur ein Lakebase-Projekt je Account → `--project <vorhandene-id>` |
| Job-Fehler beim Import des Postgres-Treibers | Der Job nutzt bewusst `pg8000` (reines Python). `psycopg2-binary` crasht auf Serverless (SIGABRT). |
| Lokale Verbindung zu Lakebase: TLS-Fehler | `ssl: { rejectUnauthorized: false }` (so in `setup.mjs`/`seed-spots.mjs`) |
| `pg_dump` gegen Lakebase: Versionsfehler | Lakebase ist PostgreSQL 17 → `docker run --rm postgres:17-alpine pg_dump …`; `?schema=` aus der URL entfernen |
| App zeigt „Noch keine Daten" | Erfassungs-Job einmal starten: `databricks bundle run windguru_ingest -t dev -p <p>` |
| App: `permission denied for table …` | Lese-SP hat keine Rechte auf eine neue Tabelle → `GRANT SELECT ON ALL TABLES IN SCHEMA windguru TO "<sp>"` |
| `prisma db push` will `ModelSeries` löschen | Nur nach `--drop-legacy` das Modell aus dem Schema nehmen (Reihenfolge oben) |
| Modellgüte/Varianten ändern sich nie | Sie dürfen erst ab genug Vergleichen: `SELECT_MIN_N` (= 0.6 × `SKILL_MAX_SNAPS`) für die Variantenwahl, `PROB_MIN_N` (= 0.5 × `SKILL_MAX_SNAPS` × 4) für die Wahrscheinlichkeits-Kalibrierung. Erreichte Werte stehen in `SpotStat.verification` (`variants[].leads[].n`, `prob.n`). Die Schwellen sind absichtlich als ANTEIL des Deckels definiert — als freie Zahlen standen sie einmal über dem erreichbaren Maximum und beide Mechanismen liefen nie an. |
| Lern-Job scheitert mit `Tabelle "Spot" ist leer` | `node scripts/setup.mjs --profile <p> --data-only` (schreibt Spots samt `stations`/`waterCodes`) |
