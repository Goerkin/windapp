"use client";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { PALETTE } from "@/lib/palette";

// Verifikation immer in kn oder m/s (Fehlermaße in Beaufort sind nicht sinnvoll → kn).
function unitOf(unit: WindUnit) {
  return unit === "ms" ? { f: (kn: number) => kn * 0.514444, label: "m/s", d: 1 } : { f: (kn: number) => kn, label: "kn", d: 1 };
}

export default function VerificationPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const v = spot.verification;
  const U = unitOf(unit);
  const fmt = (kn: number | null | undefined, d = U.d) =>
    kn == null ? "–" : U.f(kn).toFixed(d);

  if (!v) {
    return (
      <p className="text-sm text-muted">
        Noch keine Verifikation möglich — sobald genug Prognose- und Messhistorie vorliegt,
        erscheint hier die Trefferquote.
      </p>
    );
  }

  // Kern-Kennzahl: bevorzugt 24 h, sonst der Vorlauf mit den meisten Vergleichen.
  const lead24 = v.leads.find((l) => l.leadH === 24);
  const core =
    lead24 && lead24.n > 0
      ? lead24
      : [...v.leads].sort((a, b) => b.n - a.n)[0];
  const scatter = v.scatter.map((p) => ({ x: U.f(p.forecast), y: U.f(p.measured) }));
  const axMax = Math.ceil(
    Math.max(1, ...scatter.flatMap((p) => [p.x, p.y])) / 5,
  ) * 5;

  return (
    <div>
      <div className="mb-1 text-xs text-muted">
        Wie gut traf der Konsens rückblickend den gemessenen Wind? Aktives Verfahren, für jeden
        Prognosezeitpunkt nur mit den Messungen davor gelernt (ehrlich, ohne Blick in die Zukunft),
        letzte {v.windowDays} Tage.
      </div>
      <p className="mb-3 text-[11px] text-faint">
        „Treffer" = Prognose lag innerhalb ±{v.hitToleranceKn} kn am gemessenen Stundenmittel.
        Bias &gt; 0 = Prognose zu hoch. Basis: {v.obsHours} Messstunden. Baut sich mit der Zeit auf.
      </p>

      {/* Kern-Kennzahlen (Vorlauf 24 h) */}
      {core && core.n > 0 && (
        <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-3">
          <Stat label={`Trefferquote ±${v.hitToleranceKn} kn (${core.label})`} big>
            <span style={{ color: PALETTE.teal }}>
              {core.hit == null ? "–" : Math.round(core.hit * 100)}
            </span>
            <span className="ml-1 text-sm text-muted">%</span>
          </Stat>
          <Stat label={`Ø Fehler (MAE)`}>
            {fmt(core.mae)} {U.label}
          </Stat>
          <Stat label="Bias (Prognose − Messung)">
            {core.bias == null ? "–" : (core.bias > 0 ? "+" : "") + fmt(core.bias)} {U.label}
          </Stat>
          <Stat label="verglichene Stunden">{core.n}</Stat>
        </div>
      )}

      {/* Tabelle je Vorlauf */}
      <div className="mb-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="py-1.5 pr-3 font-600">Vorlauf</th>
              <th className="py-1.5 pr-3 font-600">n</th>
              <th className="py-1.5 pr-3 font-600">MAE ({U.label})</th>
              <th className="py-1.5 pr-3 font-600">Bias ({U.label})</th>
              <th className="py-1.5 pr-3 font-600">Treffer ±{v.hitToleranceKn} kn</th>
            </tr>
          </thead>
          <tbody>
            {v.leads.map((l) => (
              <tr key={l.leadH} className="border-t border-border-soft">
                <td className="py-1.5 pr-3 font-mono text-body">{l.label}</td>
                <td className="py-1.5 pr-3 text-muted">{l.n}</td>
                <td className="py-1.5 pr-3 font-mono text-body">{l.n ? fmt(l.mae) : "–"}</td>
                <td className="py-1.5 pr-3 font-mono text-body">
                  {l.n && l.bias != null ? (l.bias > 0 ? "+" : "") + fmt(l.bias) : "–"}
                </td>
                <td className="py-1.5 pr-3 font-mono" style={{ color: PALETTE.teal }}>
                  {l.n && l.hit != null ? `${Math.round(l.hit * 100)} %` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Punktwolke Prognose vs. Messung (Vorlauf 24 h) */}
      {scatter.length > 1 && (
        <>
          <div className="mb-1 text-xs uppercase tracking-wider text-muted">
            Prognose vs. Messung · Vorlauf 24 h
          </div>
          <p className="mb-2 text-[11px] text-faint">
            Jeder Punkt = eine Stunde. Auf der Diagonale = perfekt getroffen; darüber = zu wenig
            vorhergesagt, darunter = zu viel.
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <ScatterChart margin={{ top: 8, right: 10, bottom: 4, left: -18 }}>
              <CartesianGrid stroke={PALETTE.gridLine} strokeDasharray="2 4" />
              <XAxis
                type="number"
                dataKey="x"
                name="Prognose"
                domain={[0, axMax]}
                tick={{ fontSize: 12, fill: PALETTE.axis }}
                stroke={PALETTE.axisLine}
                tickLine={{ stroke: PALETTE.axisLine }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Messung"
                domain={[0, axMax]}
                width={40}
                tick={{ fontSize: 12, fill: PALETTE.axis }}
                stroke={PALETTE.axisLine}
                tickLine={{ stroke: PALETTE.axisLine }}
              />
              <ReferenceLine
                className="ref-chrome"
                segment={[{ x: 0, y: 0 }, { x: axMax, y: axMax }]}
                stroke={PALETTE.axisLine}
                strokeDasharray="4 4"
              />
              <Tooltip content={<ScatterTip label={U.label} d={U.d} />} />
              <Scatter data={scatter} fill={PALETTE.teal} fillOpacity={0.6} isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
          <div className="mt-1 text-[11px] text-faint">Achsen: Wind in {U.label}</div>
        </>
      )}
    </div>
  );
}

function Stat({ label, children, big }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className={big ? "font-display text-3xl font-700 text-ink" : "text-base text-ink"}>{children}</div>
    </div>
  );
}

function ScatterTip({
  active,
  payload,
  label,
  d,
}: {
  active?: boolean;
  payload?: Array<{ payload: { x: number; y: number } }>;
  label: string;
  d: number;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="text-body">
        Prognose <span className="font-mono text-ink">{p.x.toFixed(d)}</span> {label}
      </div>
      <div className="text-body">
        Gemessen <span className="font-mono text-ink">{p.y.toFixed(d)}</span> {label}
      </div>
    </div>
  );
}
