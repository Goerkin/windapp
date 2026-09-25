# Databricks notebook source
# Lern-Job für das Wind Cockpit — läuft als serverless Databricks-Job, UNABHÄNGIG von der
# Next.js-App.
#
# Warum: bis Version 0.1 lief das Lernen ausschließlich in der App (src/lib/skill.ts, gestartet
# aus src/instrumentation.ts). Ist die App gestoppt oder gelöscht, wächst die Datenbasis zwar
# weiter, aber Modellgüte und Nachkorrektur frieren ein. Genau das war der Zustand: die
# Rohdaten liefen 24/7 durch, ModelSkill/SpotStat standen seit dem Löschen der App still.
# Dieser Job macht das Lernen zur Eigenschaft der DATENBASIS, nicht der Oberfläche.
#
# Faithful port von src/lib/calib.ts (Modell) + src/lib/consensus.ts (Gewichtung) +
# dem früheren src/lib/skill.ts (rollierende, ehrliche Verifikation). Die App liest nur das Ergebnis
# aus SpotStat/ModelSkill und wendet es über calib.ts/consensus.ts auf die Anzeige an — beide
# Seiten müssen daher dieselbe Mathematik rechnen. Änderungen an der Mathematik gehören in
# BEIDE Dateien.
#
# Konfiguration (Spots, Messstationen, Wasser-Messstelle) kommt aus der Tabelle "Spot"
# (Spalten stations/waterCodes, befüllt von scripts/seed-spots.mjs) — dieser Job hat bewusst
# keine eigene Spot-Liste, die auseinanderlaufen könnte.
#
# Lokal testbar (dann keine Databricks-Auth nötig):
#   DATABASE_URL=postgres://… LAKEBASE_SCHEMA=public python scripts/skill_job.py

import os
import re
import ssl
import json
import math
import uuid
import time
import contextlib
import datetime as dt
from urllib.parse import urlparse, unquote

import numpy as np
import pg8000.dbapi as pgdb  # reiner Python-Postgres-Treiber (kein C, kein libpq/SSL-Konflikt)


# ════════════════════════════════════════════════════════════════════════════════════════
#  Port von src/lib/calib.ts — Nachkorrektur-Modell
# ════════════════════════════════════════════════════════════════════════════════════════

# Nach Komplexität sortiert — bei Gleichstand gewinnt die einfachere Variante.
VARIANTS = [
    {"key": "raw_equal",   "label": "Roh · gleiche Gewichte",                        "mode": "raw",  "weights": "equal"},
    {"key": "raw_skill",   "label": "Roh · Güte-Gewichte",                           "mode": "raw",  "weights": "skill"},
    {"key": "add_equal",   "label": "Bias-Korrektur · gleiche Gewichte",             "mode": "add",  "weights": "equal"},
    {"key": "add_skill",   "label": "Bias-Korrektur · Güte-Gewichte",                "mode": "add",  "weights": "skill"},
    {"key": "lin_skill",   "label": "Linear-Korrektur · Güte-Gewichte",              "mode": "lin",  "weights": "skill"},
    {"key": "linT_skill",  "label": "Linear + Wasser−Luft-Temp. · Güte-Gewichte",    "mode": "linT", "weights": "skill"},
]
DEFAULT_VARIANT = "add_skill"
VARIANT_BY_KEY = {v["key"]: v for v in VARIANTS}

MODES = ["raw", "add", "lin", "linT"]
# 0 = Achsenabschnitt, 1–4 = Quadranten N/O/S/W (Dummies), 5 = fc − 12, 6 = T_Wasser − T_Luft
N_FEAT = 7
MODE_FEATS = {
    "raw":  [],
    "add":  [0, 1, 2, 3, 4],
    "lin":  [0, 1, 2, 3, 4, 5],
    "linT": [0, 1, 2, 3, 4, 5, 6],
}
# Ridge-Strafen je Merkmal ≈ „so viele effektive Stunden Evidenz braucht es, um vom Nullwert
# wegzukommen" × typische Merkmalsgröße².
RIDGE = np.array([4.0, 12.0, 12.0, 12.0, 12.0, 15 * 36.0, 15 * 9.0])

REF_KN = 12.0
MAX_CORR_KN = 6.0

LEAD_BUCKETS = 4  # 0–24 h, 24–48 h, 48–72 h, > 72 h


def lead_bucket(lead_h):
    return max(0, min(LEAD_BUCKETS - 1, int(math.floor(lead_h / 24))))


def prior_mae(resolution):
    res = resolution if (resolution and resolution > 0) else 15.0
    return min(6.0, max(3.0, 3.0 + max(0.0, res - 2.0) * 0.12))


def prior_sigma(resolution, bucket):
    return 1.25 * prior_mae(resolution) * (1 + 0.12 * bucket)


def prior_fit(resolution, bucket):
    return {"beta": [0.0] * N_FEAT, "sigma": prior_sigma(resolution, bucket)}


def norm_cdf(z):
    """Standardnormal-Verteilungsfunktion Φ(z), vektorisiert (Abramowitz-Stegun 7.1.26)."""
    z = np.asarray(z, dtype=float)
    t = 1.0 / (1.0 + 0.3275911 * np.abs(z / math.sqrt(2.0)))
    y = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
               + 0.254829592) * t * np.exp(-(z * z) / 2.0)
    return np.where(z >= 0, 0.5 * (1 + y), 0.5 * (1 - y))


def solve(A, b):
    """Löst A·x = b für kleine Systeme; singuläre Richtungen liefern 0 (wie calib.ts)."""
    try:
        return np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        return np.linalg.lstsq(A, b, rcond=None)[0]


def fit_for(params, id_model, res, bucket, mode):
    m = (params or {}).get("models", {}).get(str(id_model)) if params else None
    if m:
        try:
            return m["fits"][bucket][mode]
        except (IndexError, KeyError):
            pass
    return prior_fit(res, bucket)


# ════════════════════════════════════════════════════════════════════════════════════════
#  Port von src/lib/consensus.ts — Interpolation + gewichteter Konsens
# ════════════════════════════════════════════════════════════════════════════════════════

def _interp(times, vals, grid):
    """Lineare Interpolation wie lerpAt(): nulls überspringen, an den Rändern der GÜLTIGEN
    Stützstellen klemmen, aber ausserhalb der Gesamt-Zeitspanne NaN (= null in der TS-Fassung)."""
    grid = np.asarray(grid, dtype=float)
    out = np.full(grid.shape, np.nan)
    if vals is None or len(times) == 0:
        return out
    v = np.array([np.nan if x is None else float(x) for x in vals], dtype=float)
    if len(v) < len(times):
        v = np.concatenate([v, np.full(len(times) - len(v), np.nan)])
    ok = ~np.isnan(v[: len(times)])
    if not ok.any():
        return out
    inside = (grid >= times[0]) & (grid <= times[-1])
    if not inside.any():
        return out
    out[inside] = np.interp(grid[inside], np.asarray(times, dtype=float)[ok], v[: len(times)][ok])
    return out


def _interp_dir(times, vals, grid):
    """Zirkuläre Interpolation einer Richtung (Grad) — über cos/sin, wie lerpDir()."""
    grid = np.asarray(grid, dtype=float)
    out = np.full(grid.shape, np.nan)
    if vals is None or len(times) == 0:
        return out
    v = np.array([np.nan if x is None else float(x) for x in vals], dtype=float)
    if len(v) < len(times):
        v = np.concatenate([v, np.full(len(times) - len(v), np.nan)])
    ok = ~np.isnan(v[: len(times)])
    if not ok.any():
        return out
    inside = (grid >= times[0]) & (grid <= times[-1])
    if not inside.any():
        return out
    t_ok = np.asarray(times, dtype=float)[ok]
    rad = np.radians(v[: len(times)][ok])
    x = np.interp(grid[inside], t_ok, np.cos(rad))
    y = np.interp(grid[inside], t_ok, np.sin(rad))
    deg = np.degrees(np.arctan2(y, x))
    out[inside] = np.where(deg < 0, deg + 360.0, deg)
    return out


def quadrant(dir_deg):
    """Richtungs-Quadrant 0–3 (N/O/S/W). floor(x + 0.5) statt np.round: numpy rundet halbe
    zur geraden Zahl, Math.round in calib.ts immer aufwärts — bei genau 225° fiele die Stunde
    sonst in einen anderen Dummy als in der App."""
    deg = np.mod(np.mod(dir_deg, 360.0) + 360.0, 360.0)
    return (np.floor(deg / 90.0 + 0.5) % 4).astype(int)


def features_matrix(fc, dir_deg, dT):
    """Merkmalsmatrix (n × N_FEAT) wie features() in calib.ts — vektorisiert."""
    n = len(fc)
    X = np.zeros((n, N_FEAT))
    X[:, 0] = 1.0
    has_dir = ~np.isnan(dir_deg)
    if has_dir.any():
        q = quadrant(np.where(has_dir, dir_deg, 0.0))
        X[np.arange(n)[has_dir], 1 + q[has_dir]] = 1.0
    X[:, 5] = fc - REF_KN
    X[:, 6] = np.where(np.isnan(dT), 0.0, dT)
    return X


class ModelRun:
    """Eine Modell-Reihe (= eine ModelRun-Zeile), vorbereitet für schnelle Interpolation."""

    __slots__ = ("id_model", "model_name", "resolution", "init_stamp", "times", "series")

    def __init__(self, id_model, model_name, resolution, init_stamp, series):
        self.id_model = id_model
        self.model_name = model_name
        self.resolution = resolution
        self.init_stamp = init_stamp
        self.series = series or {}
        self.times = self.series.get("times") or []

    def at(self, grid):
        """wind / dir / tmp auf dem Gitter (NaN = keine Abdeckung) — wie modelAt()."""
        return (_interp(self.times, self.series.get("WINDSPD"), grid),
                _interp_dir(self.times, self.series.get("WINDDIR"), grid),
                _interp(self.times, self.series.get("TMP"), grid))


def consensus_wind(runs, grid, params, variant, water_temp):
    """Schlanker Konsens für die Verifikation: je Gitterpunkt der gewichtete Mittelwind und
    die Einzelbeiträge (Wert, Gewicht, σ) für die Wahrscheinlichkeit.

    Bewusst NICHT der volle buildConsensus() aus consensus.ts — Böen, Wolken, Niederschlag
    usw. spielen für die Verifikation keine Rolle. Die Windrechnung ist identisch.

    Rückgabe: {t: {"wind": float, "samples": [(v, w, sigma_base)], "wsum": float}}
    """
    mode = variant["mode"]
    equal = variant["weights"] == "equal"
    feats = MODE_FEATS[mode]
    grid = np.asarray(grid, dtype=float)
    acc = {t: {"wind": 0.0, "wsum": 0.0, "samples": []} for t in grid}

    for r in runs:
        wind, dir_deg, tmp = r.at(grid)
        cover = ~np.isnan(wind)
        if not cover.any():
            continue
        dT = (water_temp - tmp) if water_temp is not None else np.full(grid.shape, np.nan)
        lead_h = (grid - r.init_stamp) / 3600.0
        X = features_matrix(wind, dir_deg, dT) if feats else None

        for i in np.nonzero(cover)[0]:
            bucket = lead_bucket(lead_h[i])
            fit = fit_for(params, r.id_model, r.resolution, bucket, mode)
            shift = 0.0
            if feats:
                beta = fit["beta"]
                shift = float(sum(beta[k] * X[i, k] for k in feats))
                shift = max(-MAX_CORR_KN, min(MAX_CORR_KN, shift))
            sigma = max(0.8, float(fit["sigma"]))
            w = 1.0 if equal else 1.0 / (sigma * sigma)
            v = max(0.0, float(wind[i]) - shift)
            a = acc[grid[i]]
            a["wind"] += w * v
            a["wsum"] += w
            a["samples"].append((v, w, sigma))

    out = {}
    for t, a in acc.items():
        if a["wsum"] <= 0:
            continue
        out[int(t)] = {"wind": a["wind"] / a["wsum"], "samples": a["samples"], "wsum": a["wsum"]}
    return out


def mixture_prob(samples, kn, sigma_scale=1.0):
    """P(Wind ≥ kn) als gewichtete Mischung von Normalverteilungen (Ensemble-Dressing)."""
    if not samples:
        return None
    v = np.array([s[0] for s in samples])
    w = np.array([s[1] for s in samples])
    sd = np.maximum(0.5, np.array([s[2] for s in samples]) * sigma_scale)
    p = 1.0 - norm_cdf((kn - v) / sd)
    ws = w.sum()
    return float((w * p).sum() / ws) if ws > 0 else None


def weighted_fraction(samples, kn):
    """Gewichteter Anteil der Modelle ≥ Schwelle — das harte Vergleichsmaß zum Dressing."""
    if not samples:
        return None
    w = np.array([s[1] for s in samples])
    ws = w.sum()
    if ws <= 0:
        return None
    return float(w[np.array([s[0] for s in samples]) >= kn].sum() / ws)


# ════════════════════════════════════════════════════════════════════════════════════════
#  Rollierendes, ehrliches Lernen (früher in src/lib/skill.ts, dort nur noch der Leser)
# ════════════════════════════════════════════════════════════════════════════════════════

TH_MIN = 13.0  # Mindestwind (kn) — muss zu TH.min in src/lib/kite.ts passen

# Lernfenster. War 21 Tage (= die alte Snapshot-Aufbewahrung). Da Datenstände älter als
# 21 Tage nur noch verdichtet (1 Stand/6 h), aber DAUERHAFT liegen bleiben, kann deutlich
# weiter zurück gelernt werden — das ist genau der Zweck der Verdichtung.
WINDOW_DAYS = int(os.environ.get("SKILL_WINDOW_DAYS", "90"))
# Recency-Halbwertszeit. Bei 21 Tagen Fenster waren 7 Tage richtig; bei 90 Tagen wäre das
# Fenster zu 3/4 gewichtslos. 14 Tage halten die Anpassung reaktionsschnell und nutzen den
# hinteren Teil des Fensters noch mit ~1–2 %.
HALFLIFE_DAYS = int(os.environ.get("SKILL_HALFLIFE_DAYS", "14"))
AUTOCORR_H = 3       # Stundenfehler sind ~3 h korreliert → effektive Stichprobe = Stunden/3
RUN_SPACING_H = 6    # je Modell höchstens ein Lauf pro 6 h
HORIZON_H = 240
SIGMA_PRIOR_N = 8    # Pseudo-Stunden des Auflösungs-Priors beim Restfehler
SERIES_CHUNK = 200

VERIF_MAX_SNAPS = int(os.environ.get("SKILL_MAX_SNAPS", "200"))
VERIF_MIN_HISTORY_D = 3   # erst prüfen, wenn davor ≥ 3 Tage gelernt werden konnte
VERIF_TOL_KN = 3.0
VERIF_LEADS = [(6, "6 h"), (12, "12 h"), (24, "24 h"), (48, "48 h")]
VERIF_CORE_LEAD = 24
VERIF_MAX_SCATTER = 400

# Mindestzahl Vergleiche, bevor die DATEN die Variante wählen bzw. die Wahrscheinlichkeit
# kalibrieren dürfen. Benachbarte Prognosezeitpunkte prüfen überlappende Stunden → die
# effektive Stichprobe ist kleiner als die rohe Zahl.
#
# ACHTUNG (der Grund für die Assertion unten): beide Schwellen sind durch VERIF_MAX_SNAPS
# gedeckelt — n24 zählt höchstens einen Fall je Verifikations-Stichtag, nProb höchstens einen
# je Stichtag × Vorlaufstufe. In der Vorgängerfassung standen 60 bzw. 200 gegen ein Limit von
# 48 Stichtagen: beide Schwellen waren unerreichbar, die Variantenwahl und die
# Wahrscheinlichkeits-Kalibrierung liefen deshalb NIE an.
# Bewusst ALS ANTEIL des Deckels definiert und nicht als freie Zahl — damit die Schwellen
# gar nicht mehr über das erreichbare Maximum hinausrutschen können.
SELECT_MIN_N = round(0.60 * VERIF_MAX_SNAPS)
SELECT_TOL_KN = 0.05
PROB_MIN_N = round(0.50 * VERIF_MAX_SNAPS * len(VERIF_LEADS))
SIGMA_SCALES = [0.8, 1.0, 1.25, 1.5]

NOWCAST_K = 8
NOWCAST_PRIOR_TAU = 3
NOWCAST_PRIOR_N = 5

assert SELECT_MIN_N <= VERIF_MAX_SNAPS, (
    f"SELECT_MIN_N ({SELECT_MIN_N}) > VERIF_MAX_SNAPS ({VERIF_MAX_SNAPS}) — "
    "die Variantenwahl könnte nie anlaufen.")
assert PROB_MIN_N <= VERIF_MAX_SNAPS * len(VERIF_LEADS), (
    f"PROB_MIN_N ({PROB_MIN_N}) > erreichbares Maximum "
    f"({VERIF_MAX_SNAPS * len(VERIF_LEADS)}) — die Kalibrierung könnte nie anlaufen.")


def hour_ts(sec):
    return int(sec // 3600) * 3600


def utc_naive(sec):
    """Unix-Sekunden → naives UTC-datetime. Die Prisma-Spalten sind `timestamp without time
    zone` und tragen UTC — deshalb bewusst ohne tzinfo."""
    return dt.datetime.fromtimestamp(sec, dt.timezone.utc).replace(tzinfo=None)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def jround(v, digits=0):
    """Rundet wie JavaScripts Math.round (halbe immer aufwärts: floor(x + 0.5)).

    Nicht Pythons round() — das rundet halbe zur GERADEN Zahl. Das ist kein Schönheitsfehler:
    dieselbe Differenz in quadrant() unten hat SW-Stunden (genau 225°) in einen anderen
    Richtungs-Dummy gelegt als die TypeScript-Fassung und die gelernten Koeffizienten um bis
    zu 0.34 kn verschoben."""
    m = 10 ** digits
    return math.floor(float(v) * m + 0.5) / m


def r1(v):
    return None if v is None else jround(v, 1)


def r3(v):
    return None if v is None else jround(v, 3)


# ── Suffiziente Statistiken je (Modell, Vorlauf-Stufe) ──────────────────────────────────
# Recency-Gewicht 0.5^((F−t)/H) = 2^(−F/H) · 2^(t/H): die Summen mit 2^(t/H) sind kumulativ,
# je Stichtag F wird nur skaliert. So kostet die rollierende Anpassung fast nichts extra.
class Stats:
    __slots__ = ("A", "b", "yy", "sw")

    def __init__(self):
        self.A = np.zeros((N_FEAT, N_FEAT))
        self.b = np.zeros(N_FEAT)
        self.yy = 0.0
        self.sw = 0.0

    def add_batch(self, X, y, u):
        """Ganze Stichproben-Blöcke auf einmal — vektorisiert statt Zeile für Zeile."""
        Xu = X * u[:, None]
        self.A += X.T @ Xu
        self.b += Xu.T @ y
        self.yy += float((u * y * y).sum())
        self.sw += float(u.sum())


def fit_mode(st, scale, mode, res, bucket):
    sp = prior_sigma(res, bucket)
    beta = [0.0] * N_FEAT
    if st is None or st.sw * scale <= 0:
        return {"beta": beta, "sigma": sp}
    feats = MODE_FEATS[mode]
    yy = st.yy * scale
    rss = yy
    if feats:
        idx = np.array(feats)
        A = st.A[np.ix_(idx, idx)] * scale + np.diag(RIDGE[idx])
        b = st.b[idx] * scale
        sol = solve(A, b)
        for k, f in enumerate(feats):
            beta[f] = float(sol[k])
        # RSS = yy − 2βᵀb + βᵀ(XᵀWX)β  (ohne Ridge-Anteil)
        bb = float(sol @ (st.b[idx] * scale))
        quad = float(sol @ (st.A[np.ix_(idx, idx)] * scale) @ sol)
        rss = max(0.0, yy - 2 * bb + quad)
    sw = st.sw * scale
    sigma = math.sqrt((rss + SIGMA_PRIOR_N * sp * sp) / (sw + SIGMA_PRIOR_N))
    return {"beta": [r3(v) for v in beta], "sigma": r3(sigma)}


def fit_all(stats, metas, scale):
    out = {}
    for mi, mm in enumerate(metas):
        fits = []
        ns = []
        for bk in range(LEAD_BUCKETS):
            st = stats.get(mi * LEAD_BUCKETS + bk)
            ns.append(r1((st.sw if st else 0.0) * scale))
            fits.append({mo: fit_mode(st, scale, mo, mm["resolution"], bk) for mo in MODES})
        out[str(mm["id_model"])] = {"resolution": mm["resolution"], "n": ns, "fits": fits}
    return out


# ── Hauptrechnung je Spot ───────────────────────────────────────────────────────────────

def compute_spot(conn, spot):
    spot_id = spot["id"]
    station_ids = [s["id"] for s in (spot.get("stations") or []) if s.get("id") is not None]
    if not station_ids:
        return None

    # SKILL_NOW (Unix-Sekunden) nagelt die Stichzeit fest — nur für reproduzierbare Tests
    # bzw. den Abgleich gegen die TypeScript-Fassung; im Job leer.
    now_sec = float(os.environ.get("SKILL_NOW") or time.time())
    win_start = now_sec - WINDOW_DAYS * 86400
    H = HALFLIFE_DAYS * 86400
    T0 = win_start

    def growth(t):  # kumulativer Teil des Recency-Gewichts
        return np.power(2.0, (t - T0) / H) / AUTOCORR_H

    def scale_at(F):
        return math.pow(2.0, -(F - T0) / H)

    cur = conn.cursor()

    # ── Gemessener Wind je Stunde (nur die aktuell gültigen Stationen) ───────────────────
    ph = ",".join(["%s"] * len(station_ids))
    cur.execute(
        f'SELECT "obsTime", "windAvg" FROM "StationObs" '
        f'WHERE "spotId" = %s AND "stationId" IN ({ph}) AND "obsTime" >= %s AND "windAvg" IS NOT NULL',
        [spot_id, *station_ids, utc_naive(win_start)])
    acc = {}
    for obs_time, wind in cur.fetchall():
        k = hour_ts(obs_time.replace(tzinfo=dt.timezone.utc).timestamp())
        s, n = acc.get(k, (0.0, 0))
        acc[k] = (s + float(wind), n + 1)
    if not acc:
        return {"skill": [], "verification": None, "params": None}
    measured_hours = np.array(sorted(acc), dtype=np.int64)
    measured_vals = np.array([acc[k][0] / acc[k][1] for k in measured_hours])
    meas_by_hour = {int(k): acc[k][0] / acc[k][1] for k in measured_hours}

    # ── Gemessene Wassertemperatur (Referenz-Messstelle) ────────────────────────────────
    codes = spot.get("waterCodes") or []
    w_ts, w_val = np.array([]), np.array([])
    if codes:
        cur.execute(
            'SELECT "obsTime", value FROM "WaterTemp" WHERE code = %s AND "obsTime" >= %s '
            'ORDER BY "obsTime" ASC',
            [codes[0], utc_naive(win_start - 36 * 3600)])
        rows = cur.fetchall()
        if rows:
            w_ts = np.array([r[0].replace(tzinfo=dt.timezone.utc).timestamp() for r in rows])
            w_val = np.array([float(r[1]) for r in rows])

    def water_at(t):
        """Nächstgelegene Messung innerhalb 36 h (wie waterLookup() in watertemp.ts)."""
        if len(w_ts) == 0:
            return None
        i = int(np.clip(np.searchsorted(w_ts, t), 0, len(w_ts) - 1))
        best = min((abs(w_ts[j] - t), j) for j in {max(0, i - 1), i})
        return float(w_val[best[1]]) if best[0] <= 36 * 3600 else None

    def water_at_many(ts):
        return np.array([water_at(t) if water_at(t) is not None else np.nan for t in ts])

    # ── 1. Modellläufe deduplizieren: je Modell höchstens ein Lauf pro 6 h ──────────────
    # Jede Reihe steht in "ModelRun" nur einmal; ihr erster Abruf liefert die Wassertemperatur
    # des Windguru-Headers als Rückfall.
    cur.execute(
        'SELECT r.id, r."idModel", r."initStamp", r.resolution, min(s."fetchedAt") AS first, '
        '(array_agg(s."waterTemp" ORDER BY s."fetchedAt"))[1] '
        'FROM "SnapshotRun" x JOIN "Snapshot" s ON s.id = x."snapshotId" '
        'JOIN "ModelRun" r ON r.id = x."runId" '
        'WHERE s."spotId" = %s AND s.ok AND s."fetchedAt" >= %s '
        'GROUP BY r.id ORDER BY r."idModel", r."initStamp", first',
        [spot_id, utc_naive(win_start)])
    metas, meta_idx, picked = [], {}, []
    last_model, last_init = -1, float("-inf")
    for sid, id_model, init_stamp, resolution, fetched_at, snap_water in cur.fetchall():
        if id_model not in meta_idx:
            meta_idx[id_model] = len(metas)
            metas.append({"id_model": id_model, "resolution": resolution, "label": None})
        if id_model != last_model:
            last_model, last_init = id_model, float("-inf")
        if init_stamp - last_init < RUN_SPACING_H * 3600:
            continue  # gleicher oder zu naher Lauf
        last_init = init_stamp
        picked.append((sid, snap_water))

    # ── 2. Fehler-Stichproben sammeln (spaltenweise, numpy) ─────────────────────────────
    S_t, S_key, S_y, S_X, S_short = [], [], [], [], []
    for c in range(0, len(picked), SERIES_CHUNK):
        chunk = picked[c:c + SERIES_CHUNK]
        water_of = {sid: w for sid, w in chunk}
        ph2 = ",".join(["%s"] * len(chunk))
        cur.execute(
            f'SELECT id, "idModel", "modelName", resolution, "initStamp", series '
            f'FROM "ModelRun" WHERE id IN ({ph2})', [sid for sid, _ in chunk])
        for sid, id_model, model_name, resolution, init_stamp, series in cur.fetchall():
            run = ModelRun(id_model, model_name, resolution, init_stamp,
                           series if isinstance(series, dict) else json.loads(series or "{}"))
            if not run.times:
                continue
            mm = metas[meta_idx[id_model]]
            if mm["label"] is None:
                mm["label"] = model_name
            # Nur Messstunden NACH dem Modelllauf und innerhalb des Horizonts.
            lo = int(np.searchsorted(measured_hours, init_stamp, side="right"))
            hi = int(np.searchsorted(measured_hours, init_stamp + HORIZON_H * 3600, side="right"))
            if hi <= lo:
                continue
            grid = measured_hours[lo:hi]
            wind, dir_deg, tmp = run.at(grid)
            cover = ~np.isnan(wind)
            if not cover.any():
                continue
            g = grid[cover]
            wind, dir_deg, tmp = wind[cover], dir_deg[cover], tmp[cover]
            wt = water_at_many(g)
            fallback = np.nan if water_of.get(sid) is None else float(water_of[sid])
            wt = np.where(np.isnan(wt), fallback, wt)
            dT = wt - tmp
            lead_h = (g - init_stamp) / 3600.0
            bucket = np.clip((lead_h // 24).astype(int), 0, LEAD_BUCKETS - 1)
            S_t.append(g)
            S_key.append(meta_idx[id_model] * LEAD_BUCKETS + bucket)
            S_y.append(wind - measured_vals[lo:hi][cover])
            S_X.append(features_matrix(wind, dir_deg, dT))
            S_short.append(lead_h < 48)

    if not S_t:
        return {"skill": [], "verification": None, "params": None}
    S_t = np.concatenate(S_t)
    S_key = np.concatenate(S_key)
    S_y = np.concatenate(S_y)
    S_X = np.vstack(S_X)
    S_short = np.concatenate(S_short)
    order = np.argsort(S_t, kind="stable")
    S_t, S_key, S_y, S_X, S_short = S_t[order], S_key[order], S_y[order], S_X[order], S_short[order]
    S_u = growth(S_t.astype(float))  # kumulativer Recency-Anteil

    # ── 3. Verifikations-Stichtage (ganze Snapshots, zum Nachrechnen des Konsens) ───────
    cur.execute(
        'SELECT id FROM "Snapshot" s WHERE "spotId" = %s AND ok AND "fetchedAt" >= %s '
        'AND "fetchedAt" <= %s AND EXISTS (SELECT 1 FROM "SnapshotRun" x WHERE x."snapshotId" = s.id) '
        'ORDER BY "fetchedAt" ASC',
        [spot_id,
         utc_naive(win_start + VERIF_MIN_HISTORY_D * 86400),
         utc_naive(now_sec - 6 * 3600)])
    snap_ids = [r[0] for r in cur.fetchall()]
    step = max(1, math.ceil(len(snap_ids) / VERIF_MAX_SNAPS)) if snap_ids else 1
    verif_ids = snap_ids[::step]

    v_acc = {v["key"]: [{"abs": 0.0, "err": 0.0, "hit": 0, "n": 0} for _ in VERIF_LEADS] for v in VARIANTS}
    prob_rec = {v["key"]: [[] for _ in SIGMA_SCALES] for v in VARIANTS}
    nc_pairs = {v["key"]: [] for v in VARIANTS}
    core_li = [l for l, _ in VERIF_LEADS].index(VERIF_CORE_LEAD)
    one = SIGMA_SCALES.index(1.0)

    # Was das SYSTEM zum jeweiligen Stichtag geliefert hätte: Variante und Streuungsfaktor so
    # gewählt, wie es die Regel mit den Vergleichen BIS DAHIN getan hätte. Nur diese Zahlen
    # werden als Güte berichtet. Würde man stattdessen die am Ende beste Variante mit
    # denselben Fällen bewerten, mit denen sie ausgewählt wurde, sähe sie besser aus als sie
    # ist (Auswahl-Verzerrung).
    sys_acc = [{"abs": 0.0, "err": 0.0, "hit": 0, "n": 0} for _ in VERIF_LEADS]
    sys_scatter, sys_prob, sys_frac, sys_path = [], [], [], []

    def brier(xs):
        return (sum((p - o) ** 2 for p, o in xs) / len(xs)) if xs else None

    def mean_mae(key):
        with_data = [a for a in v_acc[key] if a["n"] > 0]
        return (sum(a["abs"] / a["n"] for a in with_data) / len(with_data)) if with_data else None

    def choose_variant():
        """Einfachste Variante innerhalb SELECT_TOL_KN der besten — erst ab SELECT_MIN_N
        Vergleichen @24 h, sonst die Standard-Variante."""
        if v_acc[DEFAULT_VARIANT][core_li]["n"] < SELECT_MIN_N:
            return DEFAULT_VARIANT
        maes = {v["key"]: jround(m, 2) for v in VARIANTS if (m := mean_mae(v["key"])) is not None}
        if not maes:
            return DEFAULT_VARIANT
        best = min(maes.values())
        return next((v["key"] for v in VARIANTS
                     if v["key"] in maes and maes[v["key"]] <= best + SELECT_TOL_KN), DEFAULT_VARIANT)

    def choose_scale(key):
        """Index des Brier-besten Streuungsfaktors — erst ab PROB_MIN_N Vergleichen, sonst 1.0."""
        recs = prob_rec[key]
        best_idx = one
        if len(recs[one]) >= PROB_MIN_N:
            for i, r in enumerate(recs):
                b_i, b_best = brier(r), brier(recs[best_idx])
                if b_i is not None and (b_best is None or b_i < b_best):
                    best_idx = i
        return best_idx

    stats = {}
    ptr = 0

    def advance_to(F):
        """Alle Stichproben einarbeiten, deren MESSUNG zum Stichtag F schon vorlag."""
        nonlocal ptr
        end = int(np.searchsorted(S_t, F - 3600, side="right"))
        if end <= ptr:
            return
        sl = slice(ptr, end)
        keys = S_key[sl]
        for k in np.unique(keys):
            m = keys == k
            st = stats.get(int(k))
            if st is None:
                stats[int(k)] = st = Stats()
            st.add_batch(S_X[sl][m], S_y[sl][m], S_u[sl][m])
        ptr = end

    for c in range(0, len(verif_ids), 8):
        batch = verif_ids[c:c + 8]
        ph3 = ",".join(["%s"] * len(batch))
        cur.execute(
            f'SELECT id, "fetchedAt", "waterTemp" FROM "Snapshot" WHERE id IN ({ph3}) '
            f'ORDER BY "fetchedAt" ASC', batch)
        snaps = cur.fetchall()
        cur.execute(
            f'SELECT x."snapshotId", r."idModel", r."modelName", r.resolution, r."initStamp", r.series '
            f'FROM "SnapshotRun" x JOIN "ModelRun" r ON r.id = x."runId" '
            f'WHERE x."snapshotId" IN ({ph3})', batch)
        runs_by_snap = {}
        for snap_id, id_model, model_name, resolution, init_stamp, series in cur.fetchall():
            runs_by_snap.setdefault(snap_id, []).append(ModelRun(
                id_model, model_name, resolution, init_stamp,
                series if isinstance(series, dict) else json.loads(series or "{}")))

        for snap_id, fetched_at, snap_water in snaps:
            runs = runs_by_snap.get(snap_id) or []
            if not runs:
                continue
            F = int(fetched_at.replace(tzinfo=dt.timezone.utc).timestamp())
            advance_to(F)
            params_F = {
                "variant": DEFAULT_VARIANT,
                "models": fit_all(stats, metas, scale_at(F)),
                "sigmaScale": 1.0,
                "nowcastGain": [],
                "fittedAt": F,
            }
            base = hour_ts(F)
            nc_grid = [base + k * 3600 for k in range(NOWCAST_K + 1)]
            lead_grid = [base + l * 3600 for l, _ in VERIF_LEADS]
            grid = sorted(set(nc_grid) | set(lead_grid))
            wtemp = water_at(F)
            if wtemp is None:
                wtemp = None if snap_water is None else float(snap_water)

            # Stand der Auswahl VOR diesem Stichtag (nur frühere Vergleiche).
            sys_v = choose_variant()
            sys_si = choose_scale(sys_v)
            sys_path.append(sys_v)

            for v in VARIANTS:
                is_sys = v["key"] == sys_v
                cons = consensus_wind(runs, grid, params_F, v, wtemp)
                acc_v = v_acc[v["key"]]
                for li, (lead_h, _label) in enumerate(VERIF_LEADS):
                    t = base + lead_h * 3600
                    p = cons.get(t)
                    meas = meas_by_hour.get(t)
                    if p is None or meas is None:
                        continue
                    err = p["wind"] - meas
                    for a in ([acc_v[li], sys_acc[li]] if is_sys else [acc_v[li]]):
                        a["abs"] += abs(err)
                        a["err"] += err
                        a["n"] += 1
                        if abs(err) <= VERIF_TOL_KN:
                            a["hit"] += 1
                    obs = 1 if meas >= TH_MIN else 0
                    if is_sys:
                        if lead_h == VERIF_CORE_LEAD and len(sys_scatter) < VERIF_MAX_SCATTER:
                            sys_scatter.append(
                                {"leadH": lead_h, "forecast": r1(p["wind"]), "measured": r1(meas)})
                        frac = weighted_fraction(p["samples"], TH_MIN)
                        if frac is not None:
                            sys_frac.append((frac, obs))
                    # Wahrscheinlichkeit je Streuungsfaktor — aus DENSELBEN Beiträgen
                    # abgeleitet statt den Konsens viermal neu zu rechnen (σ skaliert nur
                    # die Mischverteilung, nicht die Gewichte).
                    for si, s in enumerate(SIGMA_SCALES):
                        pa = mixture_prob(p["samples"], TH_MIN, s)
                        if pa is not None:
                            prob_rec[v["key"]][si].append((pa, obs))
                            if is_sys and si == sys_si:
                                sys_prob.append((pa, obs))
                # Nowcast-Paare: Abweichung jetzt und k Stunden später
                m0 = meas_by_hour.get(base)
                c0 = cons.get(base)
                if m0 is not None and c0 is not None:
                    ek = []
                    for k in range(NOWCAST_K + 1):
                        mk = meas_by_hour.get(base + k * 3600)
                        ck = cons.get(base + k * 3600)
                        ek.append(None if (mk is None or ck is None) else mk - ck["wind"])
                    nc_pairs[v["key"]].append((m0 - c0["wind"], ek))

    # ── 4. Variante wählen (mit ALLEN Vergleichen — gilt ab jetzt) ──────────────────────
    # Die Tabelle je Variante ist die Rückschau über das ganze Fenster: zum Vergleichen der
    # Varianten untereinander, NICHT die berichtete Güte (die steht in sys_*).
    variant_scores = []
    for v in VARIANTS:
        acc_v = v_acc[v["key"]]
        leads = [{"leadH": lead_h, "n": acc_v[li]["n"],
                  "mae": r1(acc_v[li]["abs"] / acc_v[li]["n"]) if acc_v[li]["n"] else None}
                 for li, (lead_h, _l) in enumerate(VERIF_LEADS)]
        m = mean_mae(v["key"])
        variant_scores.append({"key": v["key"], "label": v["label"],
                               "meanMae": None if m is None else jround(m, 2),
                               "leads": leads})
    chosen = choose_variant()

    # ── 5. Wahrscheinlichkeit kalibrieren (Brier) ───────────────────────────────────────
    sigma_scale = SIGMA_SCALES[choose_scale(chosen)]
    n_prob = len(sys_prob)
    dressed = sys_prob
    base_rate = (sum(o for _p, o in dressed) / len(dressed)) if dressed else None
    bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001]
    reliability = []
    for i, lo in enumerate(bins[:-1]):
        in_bin = [(p, o) for p, o in dressed if lo <= p < bins[i + 1]]
        reliability.append({
            "lo": lo, "hi": min(1.0, bins[i + 1]), "n": len(in_bin),
            "pAvg": r3(sum(p for p, _ in in_bin) / len(in_bin)) if in_bin else None,
            "obsFreq": r3(sum(o for _, o in in_bin) / len(in_bin)) if in_bin else None,
        })

    # ── 6. Nachlauf der Kurzfrist-Korrektur: gain_k = Regression von e_k auf e_0 ────────
    pairs = nc_pairs[chosen]
    v0 = (sum(e0 * e0 for e0, _ in pairs) / len(pairs)) if pairs else 4.0
    gain = [1.0]
    for k in range(1, NOWCAST_K + 1):
        sxy = sxx = 0.0
        for e0, ek in pairs:
            if ek[k] is None:
                continue
            sxy += e0 * ek[k]
            sxx += e0 * e0
        prior = math.exp(-k / NOWCAST_PRIOR_TAU)
        g = (sxy + NOWCAST_PRIOR_N * v0 * prior) / (sxx + NOWCAST_PRIOR_N * v0)
        gain.append(r3(max(0.0, min(gain[k - 1], g))))  # monoton fallend, 0..1
    half_life = None
    for k in range(1, NOWCAST_K + 1):
        if gain[k] <= 0.5:
            half_life = r1(k - 1 + (gain[k - 1] - 0.5) / max(1e-6, gain[k - 1] - gain[k]))
            break

    # ── 7. Endgültige Parameter mit ALLEN Messungen ─────────────────────────────────────
    advance_to(float("inf"))
    params = {
        "variant": chosen,
        "models": fit_all(stats, metas, scale_at(now_sec)),
        "sigmaScale": sigma_scale,
        "nowcastGain": gain,
        "fittedAt": int(jround(now_sec)),
    }

    # ── 8. Anzeige-Kennzahlen je Modell (roh, Vorlauf < 48 h) ───────────────────────────
    scale_now = scale_at(now_sec)
    mode = VARIANT_BY_KEY[chosen]["mode"]
    skill = []
    mi_of = S_key // LEAD_BUCKETS
    u_now = S_u * scale_now
    for mi, mm in enumerate(metas):
        m = S_short & (mi_of == mi)
        sw = float(u_now[m].sum())
        sig = params["models"][str(mm["id_model"])]["fits"][0][mode]["sigma"]
        skill.append({
            "idModel": mm["id_model"],
            "label": mm["label"] or f"Modell {mm['id_model']}",
            "resolution": mm["resolution"],
            "mae": r1(float((u_now[m] * np.abs(S_y[m])).sum()) / sw) if sw > 0 else None,
            "bias": r1(float((u_now[m] * S_y[m]).sum()) / sw) if sw > 0 else None,
            "samples": r1(sw),
            "score": 1.0 / (sig * sig),
        })
    skill.sort(key=lambda r: -r["score"])

    # ── 9. Verifikations-Blob: was das System jeweils geliefert hätte ───────────────────
    c_acc = sys_acc
    leads = []
    for li, (lead_h, label) in enumerate(VERIF_LEADS):
        a = c_acc[li]
        leads.append({"leadH": lead_h, "label": label, "n": a["n"],
                      "mae": r1(a["abs"] / a["n"]) if a["n"] else None,
                      "bias": r1(a["err"] / a["n"]) if a["n"] else None,
                      "hit": jround(a["hit"] / a["n"], 2) if a["n"] else None})
    verification = None
    if any(l["n"] for l in leads):
        verification = {
            "windowDays": WINDOW_DAYS,
            "hitToleranceKn": VERIF_TOL_KN,
            "obsHours": len(meas_by_hour),
            "leads": leads,
            "scatter": sys_scatter,
            "outOfSample": True,
            # Variante/Streuung je Stichtag nur aus früheren Vergleichen gewählt.
            "prequential": True,
            "switches": sum(1 for a, b in zip(sys_path, sys_path[1:]) if a != b),
            "snapshots": len(verif_ids),
            "chosen": chosen,
            "variants": variant_scores,
            "prob": None if n_prob == 0 else {
                "threshold": TH_MIN,
                "n": n_prob,
                "sigmaScale": sigma_scale,
                "brierDressed": r3(brier(dressed)),
                "brierFraction": r3(brier(sys_frac) or 0),
                "brierClimate": None if base_rate is None else r3(base_rate * (1 - base_rate)),
                "reliability": reliability,
            },
            "nowcast": {"gain": gain, "pairs": len(pairs), "halfLifeH": half_life},
        }

    cur.close()
    return {"skill": skill, "verification": verification, "params": params}


# ════════════════════════════════════════════════════════════════════════════════════════
#  Datenbank + Job-Rahmen
# ════════════════════════════════════════════════════════════════════════════════════════

def param(name, default=None):
    """Databricks-Widget → Umgebungsvariable → Default (wie in scripts/ingest_job.py)."""
    try:
        from pyspark.dbutils import DBUtils  # noqa: F401
        import IPython
        dbutils = IPython.get_ipython().user_ns["dbutils"]
        v = dbutils.widgets.get(name)
        if v not in (None, ""):
            return v
    except Exception:
        pass
    return os.environ.get(name, default)


def connect():
    schema = param("LAKEBASE_SCHEMA", "windguru")
    url = os.environ.get("DATABASE_URL")
    if url:  # lokaler Test
        u = urlparse(re.sub(r"[?&]schema=[^&]*", "", url.strip().strip('"').strip("'")))
        conn = pgdb.connect(user=unquote(u.username or ""), password=unquote(u.password or ""),
                            host=u.hostname, port=u.port or 5432,
                            database=(u.path or "/").lstrip("/"),
                            ssl_context=ssl._create_unverified_context() if "sslmode=require" in url else None)
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
    cred = w.api_client.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": endpoint})
    user = param("PGUSER") or getattr(w.current_user.me(), "user_name", None)
    return pg_host, user, cred["token"], param("PGDATABASE", "databricks_postgres")


def _new_id():
    # Prisma nutzt cuid; das Format ist für die App egal — es muss nur eindeutiger Text sein.
    return "j" + uuid.uuid4().hex


def load_spots(conn):
    """Spots samt Laufzeit-Konfiguration aus der DB (befüllt von scripts/seed-spots.mjs)."""
    with contextlib.closing(conn.cursor()) as cur:
        cur.execute('SELECT id, name, stations, "waterCodes" FROM "Spot" ORDER BY "sortOrder", id')
        out = []
        for spot_id, name, stations, water_codes in cur.fetchall():
            def js(v):
                return json.loads(v) if isinstance(v, str) else v
            out.append({"id": spot_id, "name": name,
                        "stations": js(stations) or [], "waterCodes": js(water_codes) or []})
        return out


def persist(conn, spot_id, res):
    """Ergebnis in ModelSkill/SpotStat schreiben — in EINER Transaktion, damit die Anzeige
    nie eine halb erneuerte Güte sieht."""
    with contextlib.closing(conn.cursor()) as cur:
        for s in res["skill"]:
            cur.execute(
                'INSERT INTO "ModelSkill" ("id","spotId","idModel",label,resolution,mae,bias,'
                'samples,score,"updatedAt") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, now()) '
                'ON CONFLICT ("spotId","idModel") DO UPDATE SET label=EXCLUDED.label, '
                'resolution=EXCLUDED.resolution, mae=EXCLUDED.mae, bias=EXCLUDED.bias, '
                'samples=EXCLUDED.samples, score=EXCLUDED.score, "updatedAt"=now()',
                (_new_id(), spot_id, s["idModel"], s["label"], s["resolution"], s["mae"],
                 s["bias"], s["samples"], s["score"]))
        cur.execute(
            'INSERT INTO "SpotStat" ("spotId",verification,params,"updatedAt") '
            'VALUES (%s,%s::jsonb,%s::jsonb, now()) ON CONFLICT ("spotId") DO UPDATE SET '
            'verification=EXCLUDED.verification, params=EXCLUDED.params, "updatedAt"=now()',
            (spot_id,
             None if res["verification"] is None else json.dumps(res["verification"]),
             None if res["params"] is None else json.dumps(res["params"])))
    conn.commit()


def health(conn, spots):
    """Wächter über die Datenbasis: was ist wie alt? Läuft am Ende jedes Lern-Laufs und
    landet in der Job-Ausgabe. Eine stumme Messstation fällt so nach Stunden auf und nicht
    erst, wenn jemand die Zahlen von Hand nachschlägt."""
    out = []
    with contextlib.closing(conn.cursor()) as cur:
        for sp in spots:
            cur.execute('SELECT max("fetchedAt") FROM "Snapshot" WHERE "spotId" = %s', [sp["id"]])
            last_snap = cur.fetchone()[0]
            warn = []
            age_h = None
            if last_snap is not None:
                age_h = round((utc_now() - last_snap).total_seconds() / 3600, 1)
                if age_h > 2:
                    warn.append(f"letzter Datenabruf vor {age_h} h")
            else:
                warn.append("überhaupt kein Datenabruf")
            stations = []
            for st in sp["stations"]:
                cur.execute('SELECT max("obsTime") FROM "StationObs" WHERE "spotId" = %s '
                            'AND "stationId" = %s', [sp["id"], st["id"]])
                last = cur.fetchone()[0]
                st_age = None if last is None else round(
                    (utc_now() - last).total_seconds() / 3600, 1)
                stations.append({"id": st["id"], "name": st.get("name"), "ageH": st_age})
                if st_age is None or st_age > 6:
                    warn.append(f"Station {st.get('name') or st['id']} stumm "
                                f"({'nie' if st_age is None else str(st_age) + ' h'})")
            water_age = None
            if sp["waterCodes"]:
                cur.execute('SELECT max("obsTime") FROM "WaterTemp" WHERE code = %s',
                            [sp["waterCodes"][0]])
                lw = cur.fetchone()[0]
                if lw is not None:
                    water_age = round((utc_now() - lw).total_seconds() / 3600, 1)
                if water_age is None or water_age > 12:
                    warn.append(f"Wassertemperatur alt ({water_age} h)")
            out.append({"spot": sp["id"], "snapshotAgeH": age_h, "stations": stations,
                        "waterAgeH": water_age, "warnungen": warn})
    return out


def main():
    conn = connect()
    results = []
    try:
        spots = load_spots(conn)
        if not spots:
            raise RuntimeError('Tabelle "Spot" ist leer — erst scripts/seed-spots.mjs laufen lassen.')
        for sp in spots:
            t0 = time.time()
            try:
                res = compute_spot(conn, sp)
                if res is None:
                    results.append({"spot": sp["id"], "uebersprungen": "keine Messstation konfiguriert"})
                    continue
                persist(conn, sp["id"], res)
                v = res["verification"] or {}
                results.append({
                    "spot": sp["id"],
                    "modelle": len(res["skill"]),
                    "variante": (res["params"] or {}).get("variant"),
                    "sigmaScale": (res["params"] or {}).get("sigmaScale"),
                    "stichtage": v.get("snapshots"),
                    "messstunden": v.get("obsHours"),
                    "mae24h": next((l["mae"] for l in v.get("leads", []) if l["leadH"] == 24), None),
                    "sekunden": round(time.time() - t0, 1),
                })
            except Exception as e:
                conn.rollback()
                results.append({"spot": sp["id"], "fehler": f"{type(e).__name__}: {e}",
                                "sekunden": round(time.time() - t0, 1)})
        results.append({"gesundheit": health(conn, spots)})
    finally:
        conn.close()
    out = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "results": results}
    print("[skill]", json.dumps(out, ensure_ascii=False))
    return out


# Der Parity-Test (tests/parity) importiert nur die Mathematik. Bewusst ein Opt-out statt
# `if __name__ == "__main__"`: im Job darf das Lernen nie still ausfallen.
if os.environ.get("SKILL_IMPORT_ONLY") != "1":
    main()
