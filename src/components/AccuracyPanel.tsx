"use client";
import type { SpotPayload } from "@/lib/types";
import { type WindUnit } from "@/lib/units";
import VerificationPanel from "./VerificationPanel";
import ModelVerifyPanel from "./ModelVerifyPanel";
import MethodPanel from "./MethodPanel";
import LearnedPanel from "./LearnedPanel";

// Kategorie-Farben (identisch zu ModelPanel).
const CAT_COLOR: Record<string, string> = {
  mesoscale: "#22d3ee",
  "regional-hi": "#a78bfa",
  global: "#f59e0b",
};
const CAT_LABEL: Record<string, string> = {
  mesoscale: "hochauflösend",
  "regional-hi": "regional",
  global: "global",
};

// Fehlermaße immer in kn oder m/s (Beaufort ist als Fehlermaß nicht sinnvoll).
function unitOf(unit: WindUnit) {
  return unit === "ms"
    ? { f: (kn: number) => kn * 0.514444, label: "m/s", d: 1 }
    : { f: (kn: number) => kn, label: "kn", d: 1 };
}

/**
 * „Genauigkeit" — vereint das frühere „Treffer" und „Modell-Check". Oben das Ranking, das
 * dem EIGENEN Konsens seine Gewichte gibt (recency-gewichtete Modellgüte gegen die echte
 * Messung), darunter die Konsens-Trefferquote je Vorlauf und die tagesweise Überlagerung
 * jedes Modells gegen die Messung.
 */
export default function AccuracyPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const U = unitOf(unit);
  const skill = spot.skill ?? [];
  const scored = skill.filter((s) => s.mae != null);
  const fmt = (kn: number | null | undefined, d = U.d) => (kn == null ? "–" : U.f(kn).toFixed(d));
  const maxShare = Math.max(0.0001, ...skill.map((s) => s.hourShare));

  return (
    <div className="space-y-8">
      {/* ── Modell-Güte-Ranking (speist die Konsens-Gewichte) ─────────────────────────── */}
      <section>
        <div className="mb-1 text-xs uppercase tracking-wider text-muted">
          Welches Modell liegt hier richtig?
        </div>
        <p className="mb-3 text-[11px] text-faint">
          Vergleich jeder Modellvorhersage (Vorlauf unter 48 h, jeder Modelllauf nur einmal gezählt)
          gegen die gemessene Station; jüngere Tage zählen mehr. „Roh" = so wie Windguru es liefert,
          „nach Korrektur" = typischer Restfehler nach der statistischen Nachkorrektur. Der Konsens
          gewichtet nach dem Restfehler, getrennt nach Vorlauf.
        </p>

        {scored.length === 0 ? (
          <p className="text-sm text-muted">
            Noch keine Bewertung — sobald genug Prognose- und Messhistorie vorliegt, erscheint
            hier das Modell-Ranking. (Aktuell greift der auflösungsbasierte Prior.)
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="py-1.5 pr-3 font-600">#</th>
                  <th className="py-1.5 pr-3 font-600">Modell</th>
                  <th className="py-1.5 pr-3 font-600">Ø Fehler roh ({U.label})</th>
                  <th className="py-1.5 pr-3 font-600">nach Korrektur</th>
                  <th className="py-1.5 pr-3 font-600">Bias roh ({U.label})</th>
                  <th className="py-1.5 pr-3 font-600" title="Gewicht in einer Stunde, die alle Modelle abdecken (Vorlauf 0–24 h)">
                    Gewicht je Stunde
                  </th>
                </tr>
              </thead>
              <tbody>
                {skill.map((s, i) => {
                  const color = CAT_COLOR[s.category] ?? "#64748b";
                  return (
                    <tr key={s.idModel} className="border-t border-border-soft align-middle">
                      <td className="py-2 pr-3 font-mono text-muted">{i + 1}</td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="font-600 text-ink">{s.label}</span>
                          <span
                            className="chip"
                            style={{ color, borderColor: color + "40" }}
                            title={CAT_LABEL[s.category] ?? s.category}
                          >
                            {s.resolution != null ? `${s.resolution} km` : CAT_LABEL[s.category]}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-body">
                        {s.mae == null ? <span className="text-faint">Prior</span> : fmt(s.mae)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-body">{s.maeCorr == null ? "–" : fmt(s.maeCorr)}</td>
                      <td className="py-2 pr-3 font-mono text-body">
                        {s.bias == null ? "–" : (s.bias > 0 ? "+" : "") + fmt(s.bias)}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[color:var(--color-bg-2)]">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${(s.hourShare / maxShare) * 100}%`, background: color }}
                            />
                          </div>
                          <span className="font-mono text-[11px] text-muted">
                            {(s.hourShare * 100).toFixed(0)} %
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-faint">
              „Prior" = noch zu wenig Messhistorie, das Modell wird vorerst nach Auflösung
              gewichtet. Bias &gt; 0 = Modell prognostiziert tendenziell zu viel Wind. „Gewicht je
              Stunde" gilt, solange alle Modelle die Stunde abdecken; Kurzfrist-Modelle reichen nur
              1–3 Tage weit, danach verteilt sich ihr Gewicht auf die übrigen.
            </p>
          </div>
        )}
      </section>

      {/* ── Gelernte Korrekturen je Modell, Vorlauf und Richtung ───────────────────────── */}
      <section>
        <div className="mb-3 text-xs uppercase tracking-wider text-muted">Was hat das Lernen herausgefunden?</div>
        <LearnedPanel spot={spot} unit={unit} />
      </section>

      {/* ── Verfahren: Varianten, Kalibrierung, Nowcast ────────────────────────────────── */}
      <section>
        <div className="mb-3 text-xs uppercase tracking-wider text-muted">Welches Rechenverfahren gewinnt?</div>
        <MethodPanel spot={spot} unit={unit} />
      </section>

      {/* ── Konsens-Güte je Vorlauf (früher „Treffer") ────────────────────────────────── */}
      <section>
        <div className="mb-3 text-xs uppercase tracking-wider text-muted">
          Wie gut trifft der Konsens?
        </div>
        <VerificationPanel spot={spot} unit={unit} />
      </section>

      {/* ── Tagesweise Überlagerung Messung vs. Modelle (früher „Modell-Check") ────────── */}
      <section>
        <div className="mb-3 text-xs uppercase tracking-wider text-muted">
          Messung gegen die Modelle — Tag für Tag
        </div>
        <ModelVerifyPanel spot={spot} unit={unit} />
      </section>
    </div>
  );
}
