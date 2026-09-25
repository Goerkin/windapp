"use client";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { PALETTE } from "@/lib/palette";
import { relTime } from "./ui";
import { LEARN } from "@/lib/calib";

function unitOf(unit: WindUnit) {
  return unit === "ms" ? { f: (kn: number) => kn * 0.514444, label: "m/s", d: 2 } : { f: (kn: number) => kn, label: "kn", d: 2 };
}

/**
 * „Welches Rechenverfahren gewinnt?" — rollierende, ehrliche Verifikation: Varianten-
 * Vergleich, Kalibrierung der Wahrscheinlichkeit und der gelernte Nachlauf der
 * Kurzfrist-Korrektur.
 */
export default function MethodPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const v = spot.verification;
  const U = unitOf(unit);
  if (!v?.variants?.length) {
    return (
      <p className="text-sm text-muted">
        Noch keine Rückschau möglich — es braucht mindestens drei Tage Prognose- und Messhistorie.
        Bis dahin rechnet der Konsens mit „{spot.method.label}" und Standardwerten.
      </p>
    );
  }
  const best = Math.min(...v.variants.filter((x) => x.meanMae != null).map((x) => x.meanMae!));
  const leadsH = v.variants[0].leads.map((l) => l.leadH);
  const n24 = v.variants[0].leads.find((l) => l.leadH === 24)?.n ?? 0;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border-soft px-4 py-3 text-sm">
        <div className="text-body">
          Aktives Verfahren: <span className="font-600 text-ink">{spot.method.label}</span>
          {spot.method.fittedAt && <span className="text-faint"> · gelernt {relTime(new Date(spot.method.fittedAt * 1000).toISOString())}</span>}
        </div>
        <p className="mt-1 text-[11px] text-faint">
          Ehrliche Rückschau: für {v.snapshots} frühere Prognosezeitpunkte wurde jede Variante nur mit den
          Messungen gelernt, die DAVOR vorlagen, und dann gegen die tatsächliche Messung geprüft. Gewählt
          wird die einfachste Variante, die höchstens {LEARN.selectTolKn} kn schlechter ist als die beste
          {n24 < LEARN.selectMinN
            ? ` — noch zu wenig Vergleiche (${n24} von ${LEARN.selectMinN} bei 24 h), daher vorerst der Standard`
            : ""}
          . Mit wenigen Wochen Historie sind Unterschiede unter ~0.2 kn noch Zufall. Die Tabelle ist
          die Rückschau über alle Prüfzeitpunkte; die berichtete Güte unter „Wie gut trifft der
          Konsens?" zeigt dagegen, was jeweils die damals gewählte Variante lieferte
          {v.prequential && v.switches != null ? ` (Wechsel im Prüfzeitraum: ${v.switches})` : ""}.
        </p>
      </div>

      {/* Varianten */}
      <section>
        <div className="mb-2 text-xs uppercase tracking-wider text-muted">Varianten im Vergleich · Ø Fehler (MAE)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="py-1.5 pr-3 font-600">Variante</th>
                {leadsH.map((h) => (
                  <th key={h} className="py-1.5 pr-3 font-600">{h} h</th>
                ))}
                <th className="py-1.5 pr-3 font-600">Ø</th>
              </tr>
            </thead>
            <tbody>
              {v.variants.map((x) => {
                const active = x.key === v.chosen;
                return (
                  <tr key={x.key} className="border-t border-border-soft" style={{ background: active ? "var(--tint-accent)" : undefined }}>
                    <td className="py-1.5 pr-3 text-body">
                      {x.label}
                      {active && <span className="ml-2 chip" style={{ color: PALETTE.teal }}>aktiv</span>}
                    </td>
                    {x.leads.map((l) => (
                      <td key={l.leadH} className="py-1.5 pr-3 font-mono text-body">
                        {l.mae == null ? "–" : U.f(l.mae).toFixed(1)}
                      </td>
                    ))}
                    <td className="py-1.5 pr-3 font-mono" style={{ color: x.meanMae === best ? PALETTE.green : undefined }}>
                      {x.meanMae == null ? "–" : U.f(x.meanMae).toFixed(U.d)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          „Roh" = Modelle unverändert. „Bias" = fester Versatz je Richtungs-Quadrant. „Linear" = zusätzlich
          windstärkeabhängig. „+ Temp." = zusätzlich Wasser- minus Lufttemperatur (Durchmischung).
          „Güte-Gewichte" = 1/Restfehler², getrennt nach Vorlauf. Werte in {U.label}.
        </p>
      </section>

      {/* Wahrscheinlichkeit */}
      {v.prob && (
        <section>
          <div className="mb-2 text-xs uppercase tracking-wider text-muted">
            Stimmen die Prozente? · P(≥ {v.prob.threshold} kn)
          </div>
          <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <Metric label="Brier unsere Prozente" value={v.prob.brierDressed.toFixed(3)} good />
            <Metric label="Brier „Anteil der Modelle“" value={v.prob.brierFraction.toFixed(3)} />
            {v.prob.brierClimate != null && <Metric label="Brier Grundrate" value={v.prob.brierClimate.toFixed(3)} />}
            <Metric
              label="Streuungsfaktor"
              value={v.prob.n < 200 ? `× ${v.prob.sigmaScale} (noch fix, n < 200)` : `× ${v.prob.sigmaScale}`}
            />
            <Metric label="Vergleiche" value={String(v.prob.n)} />
          </div>
          <table className="w-full max-w-md text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="py-1 pr-3 font-600">vorhergesagt</th>
                <th className="py-1 pr-3 font-600">Ø gesagt</th>
                <th className="py-1 pr-3 font-600">tatsächlich</th>
                <th className="py-1 pr-3 font-600">n</th>
              </tr>
            </thead>
            <tbody>
              {v.prob.reliability.map((r) => (
                <tr key={r.lo} className="border-t border-border-soft">
                  <td className="py-1 pr-3 text-body">
                    {Math.round(r.lo * 100)}–{Math.round(r.hi * 100)} %
                  </td>
                  <td className="py-1 pr-3 font-mono text-body">{r.pAvg == null ? "–" : `${Math.round(r.pAvg * 100)} %`}</td>
                  <td
                    className="py-1 pr-3 font-mono"
                    style={{
                      color:
                        r.pAvg == null || r.obsFreq == null
                          ? undefined
                          : Math.abs(r.obsFreq - r.pAvg) <= 0.15
                            ? PALETTE.green
                            : PALETTE.amber,
                    }}
                  >
                    {r.obsFreq == null ? "–" : `${Math.round(r.obsFreq * 100)} %`}
                  </td>
                  <td className="py-1 pr-3 text-muted">{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] text-faint">
            Brier-Score: mittlerer quadratischer Fehler der Prozente (0 = perfekt, kleiner = besser); die
            Grundrate ist die Messlatte „immer die übliche Häufigkeit sagen". Unsere Prozente mischen je
            Modell eine Normalverteilung mit seinem typischen Restfehler; der Streuungsfaktor ist so
            gewählt, dass der Brier-Score in der Rückschau minimal wird. Die Werte oben rechnen an jedem
            Prüfzeitpunkt mit dem Faktor, der damals gewählt war — nicht mit dem nachträglich besten.
            Gut kalibriert heißt: „tatsächlich" ≈ „Ø gesagt".
          </p>
        </section>
      )}

      {/* Nowcast */}
      {v.nowcast && (
        <section>
          <div className="mb-2 text-xs uppercase tracking-wider text-muted">
            Wie lange hält eine Mess-Abweichung?
          </div>
          <div className="flex flex-wrap items-end gap-1.5">
            {v.nowcast.gain.map((g, k) => (
              <div key={k} className="flex w-9 flex-col items-center gap-1">
                <div className="flex h-16 w-5 items-end rounded bg-[color:var(--color-bg-2)]">
                  <div className="w-full rounded" style={{ height: `${g * 100}%`, background: PALETTE.teal, opacity: 0.8 }} />
                </div>
                <span className="font-mono text-[10px] text-muted">+{k} h</span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-faint">
            Anteil der aktuellen Abweichung Messung − Prognose, der k Stunden später im Schnitt noch
            besteht (Regression aus {v.nowcast.pairs} Fällen, zu e^(−k/3) hin geshrinkt)
            {v.nowcast.halfLifeH != null ? ` — Halbwertszeit ~${v.nowcast.halfLifeH} h` : ""}. Genau so stark
            wird die Prognose der nächsten Stunden korrigiert.
          </p>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-base" style={{ color: good ? PALETTE.teal : "var(--color-ink)" }}>
        {value}
      </div>
    </div>
  );
}
