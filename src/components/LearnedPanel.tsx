"use client";
import { useState } from "react";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { variantOf } from "@/lib/calib";

const QUAD = ["N", "O", "S", "W"];
// Ab so vielen effektiven Stunden hat ein Modell in einer Vorlauf-Stufe genug Evidenz,
// dass die Korrektur mehr als der Prior ist (Ridge-Strafe des Achsenabschnitts ≈ 4 h).
const THIN_N = 8;

/**
 * „Was hat das Lernen herausgefunden?" — die gelernte Nachkorrektur je Modell, Vorlauf-Stufe
 * und Windrichtung in Klartext-Zahlen. Macht nachvollziehbar, warum ein Modell im Konsens
 * nach unten oder oben verschoben wird und wie stark es zählt.
 */
export default function LearnedPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const [bucket, setBucket] = useState(0);
  const L = spot.learned;
  if (!L || !L.models.length) {
    return <p className="text-sm text-muted">Noch nichts gelernt — der Lern-Job hat für diesen Spot noch keine Parameter geschrieben.</p>;
  }
  const f = (kn: number) => (unit === "ms" ? kn * 0.514444 : kn);
  const U = unit === "ms" ? "m/s" : "kn";
  const signed = (kn: number) => {
    const v = f(kn);
    return Math.abs(v) < 0.05 ? "0" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
  };
  const equal = variantOf(spot.method.variant).weights === "equal";
  const weights = L.models.map((m) => (equal ? 1 : 1 / Math.max(0.8, m.sigma[bucket]) ** 2));
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-[11px] text-faint">
          So viel ändert die Nachkorrektur an der Rohprognose des Modells: − = das Modell sagt an
          diesem Spot typischerweise zu viel Wind voraus und wird abgesenkt, + = zu wenig, es wird
          hochgesetzt. Je Windrichtung getrennt, gekappt auf ±{L.maxCorrKn} kn je Stunde. σ = typischer
          Restfehler danach; daraus folgt das Gewicht 1/σ² im Konsens.
          {L.mode === "raw" && " Das aktive Verfahren nutzt die Rohwerte — die Korrekturen wirken derzeit nicht."}
        </p>
        <div className="seg" role="group" aria-label="Vorlauf">
          {L.leadLabels.map((l, b) => (
            <button key={l} data-active={bucket === b} onClick={() => setBucket(b)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="py-1.5 pr-3 font-600">Modell</th>
              {QUAD.map((q) => (
                <th key={q} className="py-1.5 pr-3 text-right font-600" title={`Korrektur bei Wind aus ${q} (${U})`}>
                  {q}
                </th>
              ))}
              {L.models[0].slope && (
                <th className="py-1.5 pr-3 text-right font-600" title="zusätzliche Änderung je kn Prognose über 12 kn">
                  je kn
                </th>
              )}
              {L.models[0].temp && (
                <th className="py-1.5 pr-3 text-right font-600" title="zusätzliche Änderung je °C Wasser − Luft">
                  je °C
                </th>
              )}
              <th className="py-1.5 pr-3 text-right font-600">
                <span className="normal-case">σ</span> ({U})
              </th>
              <th className="py-1.5 pr-3 text-right font-600" title="Gewicht je Stunde, wenn alle Modelle die Stunde abdecken">
                Gewicht
              </th>
              <th className="py-1.5 pr-3 text-right font-600" title="effektive Stichprobe (Stunden / 3, jüngere zählen mehr)">
                Basis
              </th>
            </tr>
          </thead>
          <tbody>
            {L.models.map((m, k) => {
              const thin = m.n[bucket] < THIN_N;
              return (
                <tr key={m.idModel} className="border-t border-border-soft" style={{ opacity: thin ? 0.55 : 1 }}>
                  <td className="py-1.5 pr-3">
                    <span className="font-600 text-ink">{m.label}</span>
                  </td>
                  {m.shift[bucket].map((v, q) => {
                    const capped = Math.abs(v) > L.maxCorrKn;
                    return (
                      <td
                        key={q}
                        className="py-1.5 pr-3 text-right font-mono"
                        style={{ color: capped ? "var(--wg-amber)" : Math.abs(v) >= 2 ? "var(--color-ink)" : "var(--color-muted)" }}
                        title={capped ? `wird auf ±${L.maxCorrKn} kn gekappt` : undefined}
                      >
                        {/* angezeigt wird die angewandte Änderung = − gelernter Fehler */}
                        {signed(-v)}
                        {capped && " ⚠"}
                      </td>
                    );
                  })}
                  {m.slope && <td className="py-1.5 pr-3 text-right font-mono text-muted">{(-m.slope[bucket]).toFixed(2)}</td>}
                  {m.temp && <td className="py-1.5 pr-3 text-right font-mono text-muted">{signed(-m.temp[bucket])}</td>}
                  <td className="py-1.5 pr-3 text-right font-mono text-body">{f(m.sigma[bucket]).toFixed(1)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-body">{((weights[k] / wSum) * 100).toFixed(0)} %</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-faint">{thin ? "kaum" : Math.round(m.n[bucket])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        Blass = in dieser Vorlauf-Stufe kaum Vergleiche (Kurzfrist-Modelle reichen oft nicht so weit);
        dort gilt weitgehend der Standardwert nach Auflösung. Die Korrektur ist mit Absicht zurückhaltend
        (Ridge-Shrinkage): mit wenig Daten bleibt sie nahe 0.
      </p>
    </div>
  );
}
