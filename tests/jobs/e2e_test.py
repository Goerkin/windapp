"""End-to-End-Test der beiden Databricks-Jobs gegen ein echtes Postgres.

    TEST_DATABASE_URL=postgresql://user:pw@localhost:5433/windguru python3 tests/jobs/e2e_test.py

Legt ein eigenes Schema "e2e_jobs" an (wird bei jedem Lauf verworfen — NUR dieses Schema),
trägt die Spots ein und prüft dann ohne Netz (alle Abrufe sind ersetzt):

  Erfassung  – eine bekannte Modell-Reihe wird nicht erneut heruntergeladen, nur verknüpft;
               eine neue `rundef` schon. Der Stationsverlauf ist idempotent. Die Verdichtung
               löscht alte Abrufe und die Reihen, auf die dann niemand mehr verweist.
  Lernen     – aus synthetischen Läufen mit bekanntem Fehler (Modell A +3 kn, Modell B
               −1.5 kn, Modell C ohne Versatz, aber verrauscht) findet der Lern-Job genau
               diese Versätze und Gewichte wieder, und die Verifikation ist rollierend.

Braucht numpy, pg8000 und Node (für prisma + seed).
"""

import datetime as dt
import importlib.util
import json
import math
import os
import re
import subprocess
import sys

import numpy as np

URL = os.environ.get("TEST_DATABASE_URL")
if not URL:
    sys.exit("TEST_DATABASE_URL fehlt (eine Postgres-DB, in der das Schema e2e_jobs angelegt werden darf).")
SCHEMA = "e2e_jobs"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BASE = re.sub(r"[?&]schema=[^&]*", "", URL)
os.environ.update({"DATABASE_URL": BASE, "LAKEBASE_SCHEMA": SCHEMA})

FAILED = []


def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        FAILED.append(msg)


def run(cmd, env=None):
    subprocess.run(cmd, check=True, cwd=ROOT, env={**os.environ, **(env or {})},
                   stdout=subprocess.DEVNULL)


def load(name, flag):
    os.environ[flag] = "1"
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "scripts", f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def utc(sec):
    return dt.datetime.fromtimestamp(sec, dt.timezone.utc).replace(tzinfo=None)


ingest = load("ingest_job", "INGEST_IMPORT_ONLY")
skill = load("skill_job", "SKILL_IMPORT_ONLY")

print("Schema anlegen …")
# Nur das eigene Test-Schema wird verworfen — nie etwas anderes in dieser DB.
conn = ingest.connect()
cur = conn.cursor()
cur.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
cur.execute(f'CREATE SCHEMA "{SCHEMA}"')
cur.close()
conn.commit()
conn.close()
sep = "&" if "?" in BASE else "?"
run(["npx", "prisma", "db", "push", "--skip-generate"], {"DATABASE_URL": f"{BASE}{sep}schema={SCHEMA}"})
run(["node", "scripts/seed-spots.mjs"])
conn = ingest.connect()


def q(sql, params=()):
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = [list(r) for r in cur.fetchall()] if cur.description else None
    cur.close()
    conn.commit()
    return rows


# ════════════════════════════════════ Erfassung ═════════════════════════════════════════
print("Erfassung:")
NOW = int(dt.datetime.now(dt.timezone.utc).timestamp())
downloads = []
rundefs = {1: "A1", 2: "B1"}


def fake_meta(sid):
    return {"models": [{"id_model": m, "rundef": r, "initstr": "x", "cachefix": "x"}
                       for m, r in rundefs.items()],
            "blend": {"model_koef": {"1": 1.5}}, "sunrise": "07:00", "sunset": "19:30",
            "waterTemp": 16.0, "timezone": "CEST"}


def fake_model(sid, m):
    downloads.append((sid, m["id_model"]))
    init = NOW - 3600
    return {"idModel": m["id_model"], "modelName": f"M{m['id_model']}", "modelLongname": None,
            "resolution": 2.0, "initStamp": init,
            "series": {"times": [init + h * 3600 for h in range(48)],
                       "WINDSPD": [10.0] * 48, "WINDDIR": [270] * 48, "TMP": [15.0] * 48}}


def fake_station(st, hours):
    return [{"unixtime": NOW - k * 600, "windAvg": 12.0, "windMax": 15.0, "windMin": 9.0,
             "windDir": 260.0, "temp": 14.0} for k in range(3)]


ingest.fetch_spot_meta = fake_meta
ingest.fetch_model = fake_model
ingest.fetch_station = fake_station
ingest.fetch_water_latest = lambda codes: []
ingest.time.sleep = lambda s: None

spots = [s["id"] for s in ingest.SPOTS]
ingest.ingest(conn)
check(len(downloads) == 2 * len(spots), f"erster Lauf lädt alle Reihen ({len(downloads)})")

# Reihen gelten erst nach RUN_REFRESH_H als fertig — künstlich altern lassen.
q('UPDATE "ModelRun" SET "firstSeen" = "firstSeen" - interval \'4 hours\'')
downloads.clear()
ingest.ingest(conn)
check(downloads == [], "zweiter Lauf lädt bekannte Reihen NICHT erneut")
n_runs = q('SELECT count(*) FROM "ModelRun"')[0][0]
n_links = q('SELECT count(*) FROM "SnapshotRun"')[0][0]
check(n_runs == 2 * len(spots) and n_links == 4 * len(spots),
      f"zwei Abrufe teilen sich die Reihen ({n_runs} Reihen, {n_links} Verweise)")
koef = q('SELECT DISTINCT koef FROM "SnapshotRun" x JOIN "ModelRun" r ON r.id = x."runId" '
         'WHERE r."idModel" = 1')
check(koef == [[1.5]], "Blend-Gewicht koef steht am Verweis")

rundefs[1] = "A2"
downloads.clear()
ingest.ingest(conn)
check(len(downloads) == len(spots) and all(m == 1 for _, m in downloads),
      "neue rundef wird geladen, die unveränderte nicht")

obs = q('SELECT "stationId", count(*) FROM "StationObs" GROUP BY 1 ORDER BY 1')
check(all(n == 3 for _, n in obs), f"Stationsverlauf idempotent (je Station 3 Werte: {obs})")

# Verdichtung: zwei alte Abrufe im selben 6-h-Fenster, der spätere mit eigener Reihe.
old = NOW - 30 * 86400
old = old - old % (6 * 3600) + 3600
sid = spots[0]
q('INSERT INTO "ModelRun" (id,"spotId","idModel",rundef,"modelName","initStamp",series,"firstSeen") '
  'VALUES (%s,%s,9,%s,%s,%s,%s::jsonb,%s)', ("old-run", sid, "OLD", "M9", old, json.dumps({"times": []}), utc(old)))
for k, snap in enumerate(["old-a", "old-b"]):
    q('INSERT INTO "Snapshot" (id,"spotId",ok,"fetchedAt") VALUES (%s,%s,TRUE,%s)', (snap, sid, utc(old + k * 1800)))
q('INSERT INTO "SnapshotRun" ("snapshotId","runId",koef) VALUES (%s,%s,1)', ("old-b", "old-run"))
res = ingest.ingest(conn)
thin = next(r for r in res if "thinned" in r)
left = q('SELECT id FROM "Snapshot" WHERE id LIKE %s ORDER BY id', ("old-%",))
check(left == [["old-a"]], f"Verdichtung behält den frühesten Abruf je 6 h ({left})")
check(q('SELECT count(*) FROM "ModelRun" WHERE id = %s', ("old-run",))[0][0] == 0 and thin["runsDropped"] >= 1,
      "verwaiste alte Reihe wird gelöscht")

# ═════════════════════════════════════ Lernen ═══════════════════════════════════════════
print("Lernen:")
for t in ["SnapshotRun", "Snapshot", "ModelRun", "StationObs", "SpotStat", "ModelSkill", "WaterTemp"]:
    q(f'DELETE FROM "{t}"')

SPOT = 97
STATION = next(s for s in ingest.SPOTS if s["id"] == SPOT)["stations"][0]["id"]
rng = np.random.default_rng(7)
DAYS = 20
END = (NOW // 3600) * 3600
START = END - DAYS * 86400
truth = lambda t: 13 + 5 * math.sin(2 * math.pi * t / (26 * 3600)) + 2 * math.sin(2 * math.pi * t / (97 * 3600))
MODELS = {101: {"bias": 3.0, "noise": 0.6, "res": 2.0},
          102: {"bias": -1.5, "noise": 0.6, "res": 2.0},
          103: {"bias": 0.0, "noise": 2.5, "res": 13.0}}

for h in range(START, END + 1, 3600):
    q('INSERT INTO "StationObs" (id,"spotId","stationId","obsTime","windAvg","windDir") '
      'VALUES (%s,%s,%s,%s,%s,270)', (f"o{h}", SPOT, STATION, utc(h + 600), truth(h)))
for F in range(START, END - 6 * 3600 + 1, 6 * 3600):
    snap = f"s{F}"
    q('INSERT INTO "Snapshot" (id,"spotId",ok,"fetchedAt","waterTemp") VALUES (%s,%s,TRUE,%s,16)',
      (snap, SPOT, utc(F)))
    init = F - 3 * 3600
    times = [init + k * 3600 for k in range(73)]
    for m, p in MODELS.items():
        wind = [max(0.0, truth(t) + p["bias"] + rng.normal(0, p["noise"])) for t in times]
        series = {"times": times, "WINDSPD": wind, "WINDDIR": [270] * 73, "TMP": [15.0] * 73}
        rid = f"r{m}-{F}"
        q('INSERT INTO "ModelRun" (id,"spotId","idModel",rundef,"modelName",resolution,"initStamp",series) '
          'VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)', (rid, SPOT, m, f"syn{init}", f"M{m}", p["res"], init, json.dumps(series)))
        q('INSERT INTO "SnapshotRun" ("snapshotId","runId",koef) VALUES (%s,%s,1)', (snap, rid))

os.environ["SKILL_NOW"] = str(END)
out = skill.main()
spot_res = next(r for r in out["results"] if r.get("spot") == SPOT)
check("fehler" not in spot_res, f"Lernlauf ohne Fehler ({spot_res})")

params = json.loads(q('SELECT params::text FROM "SpotStat" WHERE "spotId" = %s', (SPOT,))[0][0])
W = 3  # Quadrant West (Feature 1 + 3)
shift = {m: params["models"][str(m)]["fits"][0]["add"]["beta"][0] + params["models"][str(m)]["fits"][0]["add"]["beta"][1 + W]
         for m in MODELS}
sig = {m: params["models"][str(m)]["fits"][0]["add"]["sigma"] for m in MODELS}
print("    gelernt (0–24 h, West):", {m: round(v, 2) for m, v in shift.items()}, "σ:", sig)
check(abs(shift[101] - 3.0) < 0.5, "Modell A: Versatz +3 kn wiedergefunden")
check(abs(shift[102] + 1.5) < 0.5, "Modell B: Versatz −1.5 kn wiedergefunden")
check(abs(shift[103]) < 0.7, "Modell C: kein Versatz")
check(sig[103] > 1.5 * max(sig[101], sig[102]), "verrauschtes Modell C bekommt größeres σ (= weniger Gewicht)")

sk = {r[0]: r[1:] for r in q('SELECT "idModel", bias, mae FROM "ModelSkill" WHERE "spotId" = %s', (SPOT,))}
check(abs(sk[101][0] - 3.0) < 0.3 and abs(sk[102][0] + 1.5) < 0.3, f"Roh-Bias in ModelSkill ({sk})")

ver = json.loads(q('SELECT verification::text FROM "SpotStat" WHERE "spotId" = %s', (SPOT,))[0][0])
lead24 = next(l for l in ver["leads"] if l["leadH"] == 24)
check(ver.get("prequential") is True and lead24["n"] > 0, "Verifikation rollierend (prequential) mit Vergleichen")
check(lead24["mae"] is not None and lead24["mae"] < 1.5, f"korrigierter Konsens trifft (MAE@24h {lead24['mae']} kn)")

conn.close()
print()
if FAILED:
    sys.exit(f"{len(FAILED)} Prüfung(en) fehlgeschlagen.")
print("Alle Prüfungen bestanden.")
