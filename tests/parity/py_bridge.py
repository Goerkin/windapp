"""Brücke für den Parity-Test: rechnet einen Fall mit der ECHTEN Mathematik aus
scripts/skill_job.py und gibt das Ergebnis als JSON aus. Aufgerufen von
tests/parity/consensus.test.ts (Eingabe per stdin) — nicht direkt benutzen.

Braucht nur numpy. pg8000 wird gestubbt, falls lokal nicht installiert."""

import importlib.util
import json
import math
import os
import sys
import types

os.environ["SKILL_IMPORT_ONLY"] = "1"
try:
    import pg8000.dbapi  # noqa: F401
except ImportError:
    pg = types.ModuleType("pg8000")
    pg.dbapi = types.ModuleType("pg8000.dbapi")
    sys.modules["pg8000"] = pg
    sys.modules["pg8000.dbapi"] = pg.dbapi

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("skill_job", os.path.join(ROOT, "scripts", "skill_job.py"))
sj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sj)


def num(x):
    """NaN/inf → None, damit JSON gültig bleibt und null ≙ null vergleichbar ist."""
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) or math.isinf(x) else x


def main():
    fx = json.load(sys.stdin)
    runs = [sj.ModelRun(r["idModel"], r["modelName"], r["resolution"], r["initStamp"], r["series"])
            for r in fx["runs"]]

    cases = []
    for c in fx["cases"]:
        variant = sj.VARIANT_BY_KEY[c["variant"]]
        scale = (c["params"] or {}).get("sigmaScale", 1.0)
        res = sj.consensus_wind(runs, c["grid"], c["params"], variant, c["waterTemp"])
        pts = {}
        for t, a in res.items():
            pts[str(t)] = {
                "wind": num(a["wind"]),
                "samples": [[num(v), num(w), num(s)] for v, w, s in a["samples"]],
                "pAbove": num(sj.mixture_prob(a["samples"], c["probAt"], scale)),
                "pFrac": num(sj.weighted_fraction(a["samples"], c["probAt"])),
            }
        cases.append(pts)

    s = fx["scalars"]
    out = {
        "cases": cases,
        "leadBucket": [sj.lead_bucket(h) for h in s["leadH"]],
        "quadrant": [int(q) for q in sj.quadrant(s["dirs"])],
        "priorSigma": [[sj.prior_sigma(r, b) for b in range(sj.LEAD_BUCKETS)] for r in s["res"]],
        "normCdf": [num(v) for v in sj.norm_cdf(s["z"])],
        "features": [[num(v) for v in row] for row in sj.features_matrix(
            sj.np.array([f[0] for f in s["features"]], dtype=float),
            sj.np.array([math.nan if f[1] is None else f[1] for f in s["features"]]),
            sj.np.array([math.nan if f[2] is None else f[2] for f in s["features"]]))],
    }
    json.dump(out, sys.stdout)


main()
