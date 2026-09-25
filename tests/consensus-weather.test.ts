// Wettergrößen im Konsens (Temperatur, Wolken, Regen …): gemittelt wird nur über die Modelle,
// die die Größe liefern. Anlass: TMPE lieferten nur 6 von 15 Modellen, im Nenner stand aber das
// Gewicht aller — aus 21 °C wurden so 8 °C. Die Wind-Mathematik prüft der Parity-Test.

import { describe, expect, it } from "vitest";
import { buildConsensus, type SeriesInput } from "../src/lib/consensus";

const H = 3600;
const T0 = 1_760_000_400 - (1_760_000_400 % H);
const times = [T0, T0 + H, T0 + 2 * H];

function model(idModel: number, extra: Partial<SeriesInput["series"]>): SeriesInput {
  return {
    idModel,
    modelName: `M${idModel}`,
    resolution: 2,
    koef: 1,
    initStamp: T0,
    series: { times, WINDSPD: [10, 12, 14], ...extra },
  };
}

describe("Konsens: Wettergrößen", () => {
  it("fehlt eine Größe bei einem Modell, zählt dessen Gewicht dort nicht mit", () => {
    const models = [
      model(1, { TMP: [21, 21, 21], APCP1: [1, 1, 1], TCDC: [80, 80, 80] }),
      model(2, {}), // liefert nur Wind
    ];
    const { points } = buildConsensus(models, T0, null, { grid: times });
    expect(points).toHaveLength(3);
    for (const p of points) {
      expect(p.n).toBe(2); // beide Modelle tragen zum Wind bei …
      expect(p.tmp).toBe(21); // … die Temperatur kommt aber nur von Modell 1
      expect(p.precip).toBe(1);
      expect(p.cloud).toBe(80);
      expect(p.rh).toBeNull(); // liefert keiner
    }
  });

  it("liefern alle Modelle die Größe, ist es das gewichtete Mittel", () => {
    const models = [model(1, { TMP: [10, 10, 10] }), model(2, { TMP: [20, 20, 20] })];
    const { points } = buildConsensus(models, T0, null, { grid: times });
    // Gleiche Auflösung, keine Parameter ⇒ gleiche Gewichte.
    for (const p of points) expect(p.tmp).toBe(15);
  });
});
