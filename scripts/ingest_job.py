# Databricks notebook source
# 24/7-Datenerfassung für das Windguru-Dashboard — als serverless Databricks-Job.
# psycopg2-binary wird über die Serverless-Environment des Jobs vorinstalliert
# (resources/windguru_ingest.job.yml → environments), nicht per %pip zur Laufzeit.
#
# Warum Python (statt des in die App eingebauten Node-Pollers): Databricks Apps laufen nur
# im Fenster 6–23 Uhr (Lifecycle-Job), der eingebaute Poller sammelt also nur tagsüber. Für
# eine durchgehende Historie (Trends!) zieht dieser Job rund um die Uhr alle 30 min die
# Windguru-Daten und schreibt sie in dieselbe Lakebase-Postgres wie die App.
#
# Faithful port von src/lib/windguru.ts (fetch) + src/lib/ingest.ts (DB-Writes). Die App
# LIEST die Daten (Konsens/Trend werden zur Laufzeit berechnet) — hier wird nur roh
# geschrieben, exakt in das Prisma-Schema (Tabellen "Snapshot"/"ModelSeries"/"StationObs").
#
# Lokal testbar über DATABASE_URL (dann keine Databricks-Auth nötig):
#   DATABASE_URL=postgres://… LAKEBASE_SCHEMA=public python scripts/ingest_job.py

import os
import re
import ssl
import json
import time
import uuid
import contextlib
import datetime as dt
from urllib.parse import urlparse, unquote

import requests
import pg8000.dbapi as pgdb  # reiner Python-Postgres-Treiber (kein C, kein libpq/SSL-Konflikt)

# ---- Konfiguration: Spots + Live-Stationen + Wasser-Messstellen ----
# Einzige Quelle ist config/spots.json (liest auch die App und scripts/seed-spots.mjs).
# Als Databricks-Notebook gibt es kein __file__; das Arbeitsverzeichnis ist dort der Ordner
# des Notebooks (…/files/scripts). Deshalb mehrere Kandidaten, SPOTS_FILE übersteuert.
def _spots_file():
    here = []
    with contextlib.suppress(NameError):
        here.append(os.path.dirname(os.path.abspath(__file__)))
    cands = [os.environ.get("SPOTS_FILE")] + [
        os.path.join(d, "..", "config", "spots.json") for d in here + [os.getcwd()]
    ] + [os.path.join(os.getcwd(), "config", "spots.json")]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise FileNotFoundError("config/spots.json nicht gefunden (gesucht: "
                            + ", ".join(c for c in cands if c) + ")")


with open(_spots_file(), encoding="utf-8") as _f:
    _SPOT_DEFS = json.load(_f)["spots"]
# source: "windguru" (id_station, Werte in kn) | "soarcast" (location_id, Werte in m/s→kn)
SPOTS = [{"id": s["id"], "stations": s.get("stations", [])} for s in _SPOT_DEFS]
# Wassertemperatur-Messstellen von Rijkswaterstaat je Spot (erste = Referenz).
WATER = {s["id"]: [w["code"] for w in s.get("water", [])] for s in _SPOT_DEFS}
RWS_LATEST = ("https://ddapi20-waterwebservices.rijkswaterstaat.nl/"
              "ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen")
SKIP_MODEL_IDS = {83}  # GFS-Wave: kein Wind
SERIES_VARS = ["WINDSPD", "GUST", "WINDDIR", "TMP", "TMPE", "TCDC",
               "HCDC", "MCDC", "LCDC", "APCP1", "RH", "SLP"]

BASE = "https://www.windguru.cz/int/iapi.php"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/120.0 Safari/537.36")

SOARCAST_MARKERS = "https://soarcast.nl/sc/scapi.php?table=mv_measurement_location_markers"
MS_TO_KN = 1.943844


# ---- Job-/Umgebungsparameter (Databricks-Widgets, sonst Env, sonst Default) ----
def param(name, default=None):
    try:
        return dbutils.widgets.get(name)  # type: ignore  # noqa: F821
    except Exception:
        return os.environ.get(name, default)


# ============================ Windguru-Abruf ============================
def wg_get(params, referer):
    r = requests.get(BASE, params=params,
                     headers={"User-Agent": UA, "Referer": referer}, timeout=30)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and data.get("return") == "error":
        raise RuntimeError(f"Windguru-Fehler: {data.get('message')}")
    return data


def strip_tags(s):
    s = re.sub(r"<[^>]*>", " ", s or "")
    s = s.replace("&deg;", "°").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", s).strip()


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def fetch_spot_meta(id_spot):
    data = wg_get({"q": "forecast_spot", "id_spot": id_spot},
                  f"https://www.windguru.cz/{id_spot}")
    tabs = data.get("tabs") or []
    if not tabs:
        raise RuntimeError(f"forecast_spot: keine tabs für Spot {id_spot}")
    tab = tabs[0]
    text = strip_tags(tab.get("header", ""))
    sun = re.search(r"(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})", text)
    water = re.search(r"(-?\d+(?:\.\d+)?)\s*°\s*C", text)
    tz = re.search(r"(CEST|CET|UTC[^ ]*)", text)
    return {
        "models": tab.get("id_model_arr") or [],
        "blend": tab.get("blend"),
        "sunrise": sun.group(1) if sun else None,
        "sunset": sun.group(2) if sun else None,
        "waterTemp": _num(water.group(1)) if water else None,
        "timezone": tz.group(1) if tz else None,
    }


def fetch_model(id_spot, m):
    data = wg_get({
        "q": "forecast", "id_model": m["id_model"], "rundef": m["rundef"],
        "initstr": m["initstr"], "id_spot": id_spot, "cachefix": m["cachefix"],
        "WGCACHEABLE": 21600, "ai": 1,
    }, f"https://www.windguru.cz/{id_spot}")
    f = data.get("fcst")
    wm = data.get("wgmodel") or {}
    if not f or not isinstance(f.get("hours"), list):
        return None
    init = int(f.get("initstamp") or wm.get("initstamp") or 0)
    times = [init + h * 3600 for h in f["hours"]]
    series = {"times": times}
    for v in SERIES_VARS:
        if isinstance(f.get(v), list):
            series[v] = f[v]
    if not series.get("WINDSPD") or not any(x is not None for x in series["WINDSPD"]):
        return None
    res = wm.get("resolution")
    return {
        "idModel": m["id_model"],
        "modelName": wm.get("model_name") or f.get("model_name") or f"Modell {m['id_model']}",
        "modelLongname": wm.get("model_longname") or f.get("model_longname"),
        "resolution": _num(res) if res is not None else None,
        "initStamp": init,
        "series": series,
    }


def fetch_station_windguru(id_station):
    data = wg_get({"q": "station_data_current", "id_station": id_station},
                  f"https://www.windguru.cz/station/{id_station}")
    ut = data.get("unixtime")
    if ut is None:
        return None
    return {
        "unixtime": int(ut),
        "windAvg": _num(data.get("wind_avg")),
        "windMax": _num(data.get("wind_max")),
        "windMin": _num(data.get("wind_min")),
        "windDir": _num(data.get("wind_direction")),
        "temp": _num(data.get("temperature")),
    }


def fetch_station_soarcast(location_id):
    # Ein Endpunkt liefert die aktuellen Werte aller NKV/soarcast-Stationen (Wind in m/s).
    r = requests.get(SOARCAST_MARKERS, headers={
        "User-Agent": UA, "Referer": "https://soarcast.nl/web/",
        "Origin": "https://soarcast.nl", "Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    rows = r.json()
    row = next((x for x in rows if x.get("location_id") == location_id), None) if isinstance(rows, list) else None
    if not row or row.get("oldest_measurement_time") is None:
        return None
    kn = lambda v: (None if _num(v) is None else _num(v) * MS_TO_KN)
    return {
        "unixtime": int(row["oldest_measurement_time"]),
        "windAvg": kn(row.get("windsnelheid")),
        "windMax": kn(row.get("windstoot")),
        "windMin": None,
        "windDir": _num(row.get("windrichting")),
        "temp": None,
    }


def fetch_station(st):
    return (fetch_station_soarcast(st["id"]) if st.get("source") == "soarcast"
            else fetch_station_windguru(st["id"]))


# ============================ Datenbank ============================
def connect():
    schema = param("LAKEBASE_SCHEMA", "windguru")
    url = os.environ.get("DATABASE_URL")
    if url:  # lokaler Test
        u = urlparse(re.sub(r"[?&]schema=[^&]*", "", url.strip().strip('"').strip("'")))
        conn = pgdb.connect(user=unquote(u.username or ""), password=unquote(u.password or ""),
                            host=u.hostname, port=u.port or 5432,
                            database=(u.path or "/").lstrip("/"))
    else:    # Lakebase (Databricks) — Kurzzeit-Token als Passwort, TLS erforderlich.
        host, user, token, database = _lakebase_conn()
        conn = pgdb.connect(user=user, password=token, host=host, port=5432,
                            database=database, ssl_context=ssl.create_default_context())
    cur = conn.cursor()
    cur.execute(f'SET search_path TO "{schema}"')
    cur.close()
    return conn


def _lakebase_conn():
    """Host + Kurzzeit-Token für Lakebase über die Databricks-REST-API (wie src/lib/lakebase.ts)."""
    from databricks.sdk import WorkspaceClient
    w = WorkspaceClient()
    endpoint = param("LAKEBASE_ENDPOINT") or (
        f"projects/{param('LAKEBASE_PROJECT', 'windguru')}"
        f"/branches/{param('LAKEBASE_BRANCH', 'production')}/endpoints/primary")
    info = w.api_client.do("GET", f"/api/2.0/postgres/{endpoint}")
    pg_host = info["status"]["hosts"]["host"]
    cred = w.api_client.do("POST", "/api/2.0/postgres/credentials",
                           body={"endpoint": endpoint})
    token = cred["token"]
    # PG-Rolle: bevorzugt explizit gesetzt (App-Service-Principal, dem das Schema gehört),
    # sonst die laufende Identität.
    user = param("PGUSER") or getattr(w.current_user.me(), "user_name", None)
    database = param("PGDATABASE", "databricks_postgres")
    return pg_host, user, token, database


def fetch_water_latest(codes):
    """Neuester Wassertemperatur-Wert je Rijkswaterstaat-Messstelle (wie src/lib/watertemp.ts):
    mehrere Sensoren / alte Archivreihen → jüngsten Zeitpunkt nehmen und dort mitteln."""
    r = requests.post(RWS_LATEST, timeout=30, json={
        "LocatieLijst": [{"Code": c} for c in codes],
        "AquoPlusWaarnemingMetadataLijst": [
            {"AquoMetadata": {"Compartiment": {"Code": "OW"}, "Grootheid": {"Code": "T"}}}],
    })
    r.raise_for_status()
    by_code = {}
    for w in r.json().get("WaarnemingenLijst") or []:
        for m in w.get("MetingenLijst") or []:
            v = (m.get("Meetwaarde") or {}).get("Waarde_Numeriek")
            if v is None or not (-5 <= v <= 35):
                continue
            t = dt.datetime.fromisoformat(m["Tijdstip"].replace("Z", "+00:00"))
            by_code.setdefault(w["Locatie"]["Code"], []).append((t, v))
    out = []
    for code, arr in by_code.items():
        t_max = max(t for t, _ in arr)
        vals = [v for t, v in arr if t == t_max]
        out.append({"code": code,
                    "obsTime": t_max.astimezone(dt.timezone.utc).replace(tzinfo=None),
                    "value": round(sum(vals) / len(vals), 1)})
    return out


def _new_id():
    # Prisma nutzt cuid; das Format ist für die App egal — es muss nur eindeutiger Text sein.
    return "j" + uuid.uuid4().hex


def ingest(conn):
    # 0 (Standard) = unbegrenzt aufbewahren — für Saisonalitäten über Jahre.
    retention_days = int(param("SNAPSHOT_RETENTION_DAYS", "0"))
    # Verdichtung: älter als THIN_AFTER_DAYS nur noch EIN Datenstand je Spot und THIN_KEEP_H
    # Stunden. Grund: Lakebase Free Edition = 512 MB je Branch; der 30-min-Takt speichert
    # denselben Modelllauf bis zu 12× (≈ 5 MB/Tag). Verdichtet ≈ 0.4 MB/Tag → Jahre Platz.
    # Die App nutzt volle Auflösung nur für die letzten 21 Tage; das Lernen ohnehin ≤ 1 Lauf/6 h.
    thin_after_days = int(param("THIN_AFTER_DAYS", "21"))
    thin_keep_h = int(param("THIN_KEEP_H", "6"))
    results = []
    with contextlib.closing(conn.cursor()) as cur:
        for sp in SPOTS:
            sid = sp["id"]

            # 1) Live-Messungen ALLER Stationen (idempotent je Station+Messzeitpunkt) — immer.
            obs_stored = 0
            for st in sp.get("stations", []):
                try:
                    obs = fetch_station(st)
                    if not obs:
                        continue
                    obs_time = dt.datetime.utcfromtimestamp(obs["unixtime"])
                    cur.execute(
                        'INSERT INTO "StationObs" '
                        '("id","spotId","stationId","obsTime","fetchedAt",'
                        '"windAvg","windMax","windMin","windDir","temp") '
                        'VALUES (%s,%s,%s,%s, now(), %s,%s,%s,%s,%s) '
                        'ON CONFLICT ("spotId","stationId","obsTime") DO UPDATE SET '
                        '"windAvg"=EXCLUDED."windAvg","windMax"=EXCLUDED."windMax",'
                        '"windMin"=EXCLUDED."windMin","windDir"=EXCLUDED."windDir",'
                        '"temp"=EXCLUDED."temp"',
                        (_new_id(), sid, st["id"], obs_time,
                         obs["windAvg"], obs["windMax"], obs["windMin"],
                         obs["windDir"], obs["temp"]))
                    obs_stored += 1
                except Exception as e:
                    print(f"[ingest] Station {st.get('name')} ({sid}): {e}")

            # 2) Forecast: alle brauchbaren Modelle als ein Snapshot.
            try:
                meta = fetch_spot_meta(sid)
                koef_map = (meta.get("blend") or {}).get("model_koef") or {}
                models = []
                for m in meta["models"]:
                    if m["id_model"] in SKIP_MODEL_IDS:
                        continue
                    try:
                        mf = fetch_model(sid, m)
                        if mf:
                            mf["koef"] = _num(koef_map.get(str(m["id_model"]), 1)) or 1
                            models.append(mf)
                    except Exception:
                        pass  # einzelnes Modell darf ausfallen
                    time.sleep(0.15)  # höflich zur API

                if not models:
                    results.append({"spot": sid, "error": "kein Modell lieferte Wind",
                                    "obs": obs_stored})
                    continue

                snap_id = _new_id()
                cur.execute(
                    'INSERT INTO "Snapshot" '
                    '("id","spotId","ok","fetchedAt","sunrise","sunset",'
                    '"waterTemp","timezone","blend") '
                    'VALUES (%s,%s,TRUE, now(), %s,%s,%s,%s,%s::jsonb)',
                    (snap_id, sid, meta["sunrise"], meta["sunset"],
                     meta["waterTemp"], meta["timezone"],
                     json.dumps(meta["blend"]) if meta.get("blend") is not None else None))
                for mf in models:
                    cur.execute(
                        'INSERT INTO "ModelSeries" '
                        '("id","snapshotId","idModel","modelName","modelLongname",'
                        '"resolution","koef","initStamp","series") '
                        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',
                        (_new_id(), snap_id, mf["idModel"], mf["modelName"],
                         mf["modelLongname"], mf["resolution"], mf["koef"],
                         mf["initStamp"], json.dumps(mf["series"])))
                results.append({"spot": sid, "models": len(models), "obs": obs_stored})
            except Exception as e:
                results.append({"spot": sid, "error": str(e), "obs": obs_stored})

        # 3) Wassertemperatur (Rijkswaterstaat) — idempotent je Messstelle+Zeitpunkt.
        try:
            code_spot = {c: sid for sid, codes in WATER.items() for c in codes}
            for w in fetch_water_latest(list(code_spot)):
                cur.execute(
                    'INSERT INTO "WaterTemp" ("id","spotId","code","obsTime","value","fetchedAt") '
                    'VALUES (%s,%s,%s,%s,%s, now()) ON CONFLICT ("code","obsTime") DO NOTHING',
                    (_new_id(), code_spot[w["code"]], w["code"], w["obsTime"], w["value"]))
            results.append({"water": "ok"})
        except Exception as e:
            results.append({"water": f"Fehler: {e}"})

        # 5) Nur bei gesetzter Aufbewahrung alte Snapshots/Messungen löschen.
        if retention_days > 0:
            cutoff = dt.datetime.utcnow() - dt.timedelta(days=retention_days)
            cur.execute('DELETE FROM "Snapshot" WHERE "fetchedAt" < %s', (cutoff,))
            cur.execute('DELETE FROM "StationObs" WHERE "obsTime" < %s', (cutoff,))

    conn.commit()

    # 4) Verdichten — erst NACH dem Commit und in eigener Transaktion: ein Fehler hier darf
    #    die frisch geschriebenen Daten nie mitreißen. Je Spot und thin_keep_h-Zeitfenster
    #    bleibt der früheste Datenstand; ModelSeries hängen per ON DELETE CASCADE dran.
    if thin_after_days > 0 and thin_keep_h > 0:
        try:
            thin_cut = dt.datetime.utcnow() - dt.timedelta(days=thin_after_days)
            with contextlib.closing(conn.cursor()) as cur:
                cur.execute(
                    'DELETE FROM "Snapshot" WHERE "id" IN ('
                    ' SELECT "id" FROM ('
                    '  SELECT "id", row_number() OVER ('
                    '   PARTITION BY "spotId", floor(extract(epoch from "fetchedAt") / (%s * 3600))'
                    '   ORDER BY "fetchedAt") AS rn'
                    '  FROM "Snapshot" WHERE "fetchedAt" < %s) x'
                    ' WHERE rn > 1)',
                    (thin_keep_h, thin_cut))
                results.append({"thinned": cur.rowcount})
            conn.commit()
        except Exception as e:
            conn.rollback()
            results.append({"thinned": f"Fehler: {e}"})
    return results


def main():
    conn = connect()
    try:
        res = ingest(conn)
    finally:
        conn.close()
    out = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "results": res}
    print("[ingest]", json.dumps(out))
    return out


main()
