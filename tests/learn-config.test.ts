// Die Hilfe-Seite erklärt den Rechenweg mit den Stellschrauben des Lern-Jobs. Gerechnet wird
// in scripts/skill_job.py, angezeigt aus LEARN (src/lib/calib.ts). Dieser Test hält beide
// gleich — sonst erklärt die Hilfe still eine andere Rechnung als die, die läuft.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEARN, MAX_CORR_KN, RIDGE } from "../src/lib/calib";

const py = readFileSync(fileURLToPath(new URL("../scripts/skill_job.py", import.meta.url)), "utf8");

/** Rechte Seite von `NAME = …` auf oberster Ebene (Kommentar abgeschnitten). */
function rhs(name: string): string {
  const m = py.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*(#.*)?$`, "m"));
  if (!m) throw new Error(`${name} nicht in skill_job.py gefunden`);
  return m[1];
}

/** Zahl aus `NAME = 3`, `NAME = int(os.environ.get("…", "90"))` o. ä. */
function num(name: string): number {
  const m = rhs(name).match(/-?\d+(\.\d+)?/g);
  if (!m) throw new Error(`${name}: keine Zahl`);
  return Number(m.at(-1));
}

/** Zahlen-Liste aus `NAME = [0.8, 1.0, …]`. */
function list(name: string): number[] {
  return [...rhs(name).matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
}

describe("LEARN spiegelt scripts/skill_job.py", () => {
  it.each([
    ["WINDOW_DAYS", LEARN.windowDays],
    ["HALFLIFE_DAYS", LEARN.halfLifeDays],
    ["AUTOCORR_H", LEARN.autocorrH],
    ["RUN_SPACING_H", LEARN.runSpacingH],
    ["HORIZON_H", LEARN.horizonH],
    ["SIGMA_PRIOR_N", LEARN.sigmaPriorN],
    ["VERIF_MAX_SNAPS", LEARN.verifMaxSnaps],
    ["VERIF_MIN_HISTORY_D", LEARN.verifMinHistoryD],
    ["VERIF_TOL_KN", LEARN.verifTolKn],
    ["SELECT_TOL_KN", LEARN.selectTolKn],
    ["NOWCAST_K", LEARN.nowcastK],
    ["NOWCAST_PRIOR_TAU", LEARN.nowcastPriorTau],
    ["NOWCAST_PRIOR_N", LEARN.nowcastPriorN],
    ["MAX_CORR_KN", MAX_CORR_KN],
  ])("%s", (name, value) => {
    expect(num(name)).toBe(value);
  });

  it("SIGMA_SCALES", () => expect(list("SIGMA_SCALES")).toEqual([...LEARN.sigmaScales]));

  it("VERIF_LEADS", () => {
    const leads = [...rhs("VERIF_LEADS").matchAll(/\((\d+),/g)].map((m) => Number(m[1]));
    expect(leads).toEqual([...LEARN.verifLeads]);
  });

  it("abgeleitete Schwellen (SELECT_MIN_N, PROB_MIN_N)", () => {
    // Im Job als Anteil von VERIF_MAX_SNAPS definiert — hier nachrechnen.
    expect(Math.round(0.6 * LEARN.verifMaxSnaps)).toBe(LEARN.selectMinN);
    expect(Math.round(0.5 * LEARN.verifMaxSnaps * LEARN.verifLeads.length)).toBe(LEARN.probMinN);
    expect(rhs("SELECT_MIN_N")).toContain("0.60 * VERIF_MAX_SNAPS");
    expect(rhs("PROB_MIN_N")).toContain("0.50 * VERIF_MAX_SNAPS * len(VERIF_LEADS)");
  });

  it("RIDGE", () => {
    // Python schreibt einzelne Einträge als Produkt (15 * 36.0) — ausrechnen statt parsen.
    const terms = rhs("RIDGE").replace(/^np\.array\(\[|\]\)$/g, "").split(",");
    const values = terms.map((t) => t.split("*").reduce((a, f) => a * Number(f.trim()), 1));
    expect(values).toEqual(RIDGE);
  });
});
