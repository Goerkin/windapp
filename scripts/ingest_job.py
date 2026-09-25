# Databricks notebook source
# 24/7-Datenerfassung für das Wind Cockpit — als serverless Databricks-Job (alle 30 min).
# Der Postgres-Treiber pg8000 kommt über die Serverless-Environment des Jobs
# (resources/windguru_ingest.job.yml → environments); psycopg2 crasht auf Serverless.
#
# Einer von genau zwei Schreibpfaden in die DB (der andere ist der Lern-Job). Die App liest
# nur. Hier wird roh geschrieben, exakt in das Prisma-Schema: "Snapshot" (ein Abruf),
# "ModelRun" (jede Modell-Reihe GENAU EINMAL, Schlüssel = Windgurus `rundef`),
# "SnapshotRun" (welcher Abruf welche Reihen sah), "StationObs", "WaterTemp".
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


def fetch_station_windguru(id_station, hours):
    """10-min-Mittel der letzten `hours` Stunden. Bei jedem Lauf wird das ganze Fenster neu
    geholt und idempotent geschrieben — ein ausgefallener Lauf hinterlässt so keine Lücke,
    und das Stundenmittel fürs Lernen beruht auf 6 Werten statt auf 1–2 Momentaufnahmen.
    from/to als ISO-Zeit mit „Z" (UTC); ohne Zone deutet Windguru sie als Ortszeit."""
    now = dt.datetime.now(dt.timezone.utc)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    data = wg_get({"q": "station_data", "id_station": id_station,
                   "from": (now - dt.timedelta(hours=hours)).strftime(fmt),
                   "to": now.strftime(fmt), "avg_minutes": 10, "graph_info": 1},
                  f"https://www.windguru.cz/station/{id_station}")
    ts = data.get("unixtime") or []
    col = lambda k: data.get(k) or [None] * len(ts)
    avg, mx, mn, wd, tp = (col("wind_avg"), col("wind_max"), col("wind_min"),
                           col("wind_direction"), col("temperature"))
    return [{"unixtime": int(t), "windAvg": _num(avg[i]), "windMax": _num(mx[i]),
             "windMin": _num(mn[i]), "windDir": _num(wd[i]), "temp": _num(tp[i])}
            for i, t in enumerate(ts) if t is not None and avg[i] is not None]


def fetch_station_soarcast(location_id):
    # Ein Endpunkt liefert die aktuellen Werte aller NKV/soarcast-Stationen (Wind in m/s).
    # Einen Verlauf bietet soarcast nicht an (geprüft 09/2026: scapi.php kennt nur den
    # jeweils letzten 10-min-Wert) — hier bleibt es bei einem Wert je Lauf.
    r = requests.get(SOARCAST_MARKERS, headers={
        "User-Agent": UA, "Referer": "https://soarcast.nl/web/",
        "Origin": "https://soarcast.nl", "Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    rows = r.json()
    row = next((x for x in rows if x.get("location_id") == location_id), None) if isinstance(rows, list) else None
    if not row or row.get("oldest_measurement_time") is None:
        return []
    kn = lambda v: (None if _num(v) is None else _num(v) * MS_TO_KN)
    return [{
        "unixtime": int(row["oldest_measurement_time"]),
        "windAvg": kn(row.get("windsnelheid")),
        "windMax": kn(row.get("windstoot")),
        "windMin": None,
        "windDir": _num(row.get("windrichting")),
        "temp": None,
    }]


def fetch_station(st, hours):
    """Messungen einer Station als Liste (Windguru: Verlauf, soarcast: nur aktueller Wert)."""
    return (fetch_station_soarcast(st["id"]) if st.get("source") == "soarcast"
            else fetch_station_windguru(st["id"], hours))


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


def _utc_naive(sec=None):
    """Unix-Sekunden (Standard: jetzt) → naives UTC-datetime. Die Prisma-Spalten sind
    `timestamp without time zone` und tragen UTC."""
    t = time.time() if sec is None else sec
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).replace(tzinfo=None)


# Eine gerade erst aufgetauchte Reihe wird noch so lange erneut abgerufen: Windguru
# veröffentlicht manche Läufe schrittweise (GFS wuchs z. B. von 177 auf 181 Stunden). Danach
# gilt eine bekannte `rundef` als fertig und wird nicht mehr heruntergeladen.
RUN_REFRESH_H = 3


def _series_len(series):
    return sum(1 for v in (series.get("WINDSPD") or []) if v is not None)


def store_runs(cur, sid, meta):
    """Alle brauchbaren Modell-Reihen eines Spots sicherstellen → [(runId, koef)].

    Bekannte `rundef` (älter als RUN_REFRESH_H) werden nicht heruntergeladen, nur verknüpft —
    das spart den Großteil der Windguru-Anfragen."""
    koef_map = (meta.get("blend") or {}).get("model_koef") or {}
    wanted = [m for m in meta["models"]
              if m["id_model"] not in SKIP_MODEL_IDS and m.get("rundef")]
    known = {}
    if wanted:
        ph = ",".join(["%s"] * len(wanted))
        cur.execute(
            f'SELECT "idModel", rundef, id, "firstSeen", series FROM "ModelRun" '
            f'WHERE "spotId" = %s AND rundef IN ({ph})',
            [sid, *[m["rundef"] for m in wanted]])
        for id_model, rundef, rid, first_seen, series in cur.fetchall():
            known[(id_model, rundef)] = (rid, first_seen, series)

    fresh_cut = _utc_naive(time.time() - RUN_REFRESH_H * 3600)
    out, fetched = [], 0
    for m in wanted:
        koef = _num(koef_map.get(str(m["id_model"]), 1)) or 1
        hit = known.get((m["id_model"], m["rundef"]))
        if hit and hit[1] < fresh_cut:
            out.append((hit[0], koef))
            continue
        try:
            mf = fetch_model(sid, m)
            fetched += 1
            time.sleep(0.15)  # höflich zur API
        except Exception:
            mf = None  # einzelnes Modell darf ausfallen
        if not mf:
            if hit:
                out.append((hit[0], koef))
            continue
        if hit:
            old = hit[2] if isinstance(hit[2], dict) else json.loads(hit[2] or "{}")
            if _series_len(mf["series"]) > _series_len(old):
                cur.execute('UPDATE "ModelRun" SET series = %s::jsonb WHERE id = %s',
                            (json.dumps(mf["series"]), hit[0]))
            out.append((hit[0], koef))
            continue
        cur.execute(
            'INSERT INTO "ModelRun" ("id","spotId","idModel","rundef","modelName",'
            '"modelLongname","resolution","initStamp","series","firstSeen") '
            'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb, now()) '
            'ON CONFLICT ("spotId","idModel","rundef") DO NOTHING RETURNING id',
            (_new_id(), sid, mf["idModel"], m["rundef"], mf["modelName"], mf["modelLongname"],
             mf["resolution"], mf["initStamp"], json.dumps(mf["series"])))
        row = cur.fetchone()
        if row is None:  # parallel angelegt
            cur.execute('SELECT id FROM "ModelRun" WHERE "spotId"=%s AND "idModel"=%s AND rundef=%s',
                        (sid, mf["idModel"], m["rundef"]))
            row = cur.fetchone()
        out.append((row[0], koef))
    return out, fetched


def ingest(conn):
    # 0 (Standard) = unbegrenzt aufbewahren — für Saisonalitäten über Jahre.
    retention_days = int(param("SNAPSHOT_RETENTION_DAYS", "0"))
    # Verdichtung: älter als THIN_AFTER_DAYS nur noch EIN Abruf je Spot und THIN_KEEP_H Stunden;
    # Modell-Reihen, auf die dann kein Abruf mehr verweist, fallen mit weg. Das Lernen nutzt
    # ohnehin höchstens einen Lauf je Modell und 6 h, die App volle Auflösung nur 21 Tage.
    thin_after_days = int(param("THIN_AFTER_DAYS", "21"))
    thin_keep_h = int(param("THIN_KEEP_H", "6"))
    # So viele Stunden Stationsverlauf holt jeder Lauf nach (Windguru-Stationen).
    station_back_h = int(param("STATION_BACKFILL_H", "6"))
    results = []
    with contextlib.closing(conn.cursor()) as cur:
        for sp in SPOTS:
            sid = sp["id"]

            # 1) Messungen ALLER Stationen (idempotent je Station+Messzeitpunkt) — immer.
            obs_stored = 0
            for st in sp.get("stations", []):
                try:
                    for obs in fetch_station(st, station_back_h):
                        cur.execute(
                            'INSERT INTO "StationObs" '
                            '("id","spotId","stationId","obsTime","fetchedAt",'
                            '"windAvg","windMax","windMin","windDir","temp") '
                            'VALUES (%s,%s,%s,%s, now(), %s,%s,%s,%s,%s) '
                            'ON CONFLICT ("spotId","stationId","obsTime") DO UPDATE SET '
                            '"windAvg"=EXCLUDED."windAvg","windMax"=EXCLUDED."windMax",'
                            '"windMin"=EXCLUDED."windMin","windDir"=EXCLUDED."windDir",'
                            '"temp"=EXCLUDED."temp"',
                            (_new_id(), sid, st["id"], _utc_naive(obs["unixtime"]),
                             obs["windAvg"], obs["windMax"], obs["windMin"],
                             obs["windDir"], obs["temp"]))
                        obs_stored += 1
                except Exception as e:
                    print(f"[ingest] Station {st.get('name')} ({sid}): {e}")

            # 2) Prognose: ein Abruf, der auf alle aktuellen Modell-Reihen verweist.
            try:
                meta = fetch_spot_meta(sid)
                runs, fetched = store_runs(cur, sid, meta)
                if not runs:
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
                for run_id, koef in runs:
                    cur.execute(
                        'INSERT INTO "SnapshotRun" ("snapshotId","runId","koef") '
                        'VALUES (%s,%s,%s) ON CONFLICT DO NOTHING', (snap_id, run_id, koef))
                results.append({"spot": sid, "models": len(runs), "downloaded": fetched,
                                "obs": obs_stored})
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

        # 4) Nur bei gesetzter Aufbewahrung alte Abrufe/Messungen löschen.
        if retention_days > 0:
            cutoff = _utc_naive(time.time() - retention_days * 86400)
            cur.execute('DELETE FROM "Snapshot" WHERE "fetchedAt" < %s', (cutoff,))
            cur.execute('DELETE FROM "StationObs" WHERE "obsTime" < %s', (cutoff,))
            cur.execute('DELETE FROM "ModelRun" r WHERE r."firstSeen" < %s AND NOT EXISTS '
                        '(SELECT 1 FROM "SnapshotRun" x WHERE x."runId" = r.id)', (cutoff,))

    conn.commit()

    # 5) Verdichten — erst NACH dem Commit und in eigener Transaktion: ein Fehler hier darf
    #    die frisch geschriebenen Daten nie mitreißen. Je Spot und thin_keep_h-Zeitfenster
    #    bleibt der früheste Abruf; SnapshotRun hängt per ON DELETE CASCADE dran, danach
    #    fallen die Reihen weg, auf die niemand mehr verweist.
    if thin_after_days > 0 and thin_keep_h > 0:
        try:
            thin_cut = _utc_naive(time.time() - thin_after_days * 86400)
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
                thinned = cur.rowcount
                cur.execute('DELETE FROM "ModelRun" r WHERE r."firstSeen" < %s AND NOT EXISTS '
                            '(SELECT 1 FROM "SnapshotRun" x WHERE x."runId" = r.id)', (thin_cut,))
                results.append({"thinned": thinned, "runsDropped": cur.rowcount})
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


# Der Job-Test (tests/jobs) importiert nur die Funktionen. Bewusst ein Opt-out statt
# `if __name__ == "__main__"`: als Databricks-Notebook muss der Aufruf immer laufen.
if os.environ.get("INGEST_IMPORT_ONLY") != "1":
    main()
