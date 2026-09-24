// config/spots.json ist die einzige Quelle der Spots (App, Erfassungs-Job, Seed). JSON hat
// keine Typen — src/lib/spots.ts castet nur. Dieser Test prüft die Form stattdessen.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPOTS } from "../src/lib/spots";

const inRange = ([a, b]: [number, number]) => a >= 0 && a <= 360 && b >= 0 && b <= 360;

describe("config/spots.json", () => {
  it("hat Spots mit eindeutigen IDs, Slugs und Sortierung", () => {
    expect(SPOTS.length).toBeGreaterThan(0);
    for (const key of ["id", "slug", "sortOrder"] as const) {
      expect(new Set(SPOTS.map((s) => s[key])).size, key).toBe(SPOTS.length);
    }
  });

  it.each(SPOTS.map((s) => [s.name, s] as const))("%s: Felder vollständig und plausibel", (_, s) => {
    expect(Number.isInteger(s.id)).toBe(true);
    expect(s.slug).toMatch(/^[a-z0-9-]+$/);
    expect(s.name && s.region).toBeTruthy();
    expect(Math.abs(s.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(s.lon)).toBeLessThanOrEqual(180);
    for (const sec of [...s.dirs.good, ...s.dirs.ok, ...(s.dirs.hints ?? []).map((h) => h.range)]) {
      expect(sec).toHaveLength(2);
      expect(inRange(sec), `Sektor ${sec}`).toBe(true);
    }
    for (const st of s.stations ?? []) {
      expect(Number.isInteger(st.id)).toBe(true);
      expect(["windguru", "soarcast"]).toContain(st.source);
    }
    for (const w of s.water ?? []) expect(w.code).toMatch(/^[a-z0-9.]+$/);
  });

  it("der Erfassungs-Job liest dieselben Spots, Stationen und Wasser-Messstellen", () => {
    // Nur den Konfigurationsteil von ingest_job.py ausführen (ohne Netzwerk/DB-Importe).
    const script = fileURLToPath(new URL("../scripts/ingest_job.py", import.meta.url));
    const out = execFileSync(process.env.PYTHON ?? "python3", ["-c", `
import json, sys, types
for m in ("requests", "pg8000", "pg8000.dbapi"):
    sys.modules[m] = types.ModuleType(m)
sys.modules["pg8000"].dbapi = sys.modules["pg8000.dbapi"]
src = open(sys.argv[1], encoding="utf-8").read()
g = {"__file__": sys.argv[1]}
exec(src[: src.index("RWS_LATEST = (")], g)
print(json.dumps({"spots": g["SPOTS"], "water": g["WATER"]}))
`, script]).toString();
    const py = JSON.parse(out) as { spots: { id: number; stations: { id: number; source: string }[] }[]; water: Record<string, string[]> };
    expect(py.spots.map((s) => s.id)).toEqual(SPOTS.map((s) => s.id));
    py.spots.forEach((s, i) =>
      expect(s.stations.map((st) => [st.id, st.source])).toEqual((SPOTS[i].stations ?? []).map((st) => [st.id, st.source])),
    );
    for (const s of SPOTS) expect(py.water[String(s.id)]).toEqual((s.water ?? []).map((w) => w.code));
  });
});
