"use client";
import type { SpotPayload } from "@/lib/types";
import { convertWind, unitLabel, type WindUnit } from "@/lib/units";
import { TH, nowcastCutoff, nowcastOffsetAt, probAtLeast } from "@/lib/kite";

const TZ = "Europe/Amsterdam";
const whenFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * „Wie entsteht der Wert?" — die Rechnung einer einzelnen Konsens-Stunde zum Nachprüfen:
 * je Modell Rohwert, gelernte Korrektur, korrigierter Wert, typischer Restfehler σ und der
 * Anteil, mit dem es in DIESE Stunde eingeht. Modelle ohne Daten für die Stunde stehen
 * darunter mit Grund — so ist sichtbar, warum ein Modell „fehlt".
 */
export default function HourBreakdown({
  spot,
  index,
  unit,
  onStep,
}: {
  spot: SpotPayload;
  index: number;
  unit: WindUnit;
  onStep: (delta: number) => void;
}) {
  const t = spot.gridTimes[index];
  const point = spot.points[index];
  if (t == null || !point) return null;

  const maxCorr = spot.learned?.maxCorrKn ?? 6;
  const U = unitLabel(unit);
  const f = (kn: number | null | undefined, signed = false) => {
    if (kn == null) return "–";
    const v = convertWind(kn, unit) ?? 0;
    return signed && v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
  };

  const rows = spot.models
    .map((m) => ({ m, raw: m.wind[index], adj: m.windAdj?.[index] ?? m.wind[index], w: m.wh?.[index] ?? null, sigma: m.sigma?.[index] ?? null }))
    .filter((r) => r.raw != null && r.w != null && r.w > 0);
  const wSum = rows.reduce((a, r) => a + (r.w ?? 0), 0) || 1;
  const withShare = rows
    .map((r) => ({ ...r, share: (r.w ?? 0) / wSum }))
    .sort((a, b) => b.share - a.share);
  const maxShare = Math.max(0.0001, ...withShare.map((r) => r.share));
  const missing = spot.models.filter((m) => m.wind[index] == null);

  const off = nowcastOffsetAt(spot.nowcast, t, nowcastCutoff(spot));
  const pMin = probAtLeast(spot, index, TH.min, off);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wider text-muted">
          Wie entsteht der Wert für <span className="text-ink">{whenFmt.format(new Date(t * 1000))}</span>?
        </div>
        <div className="seg" role="group" aria-label="Stunde wechseln">
          <button onClick={() => onStep(-1)} disabled={index <= 0} aria-label="eine Stunde früher">
            ◀ 1 h
          </button>
          <button onClick={() => onStep(1)} disabled={index >= spot.gridTimes.length - 1} aria-label="eine Stunde später">
            1 h ▶
          </button>
        </div>
      </div>
      <p className="mb-2 text-[11px] text-faint">
        Stunde im Diagramm antippen, um sie hier aufzuschlüsseln. Korrektur = was die gelernte
        Nachkorrektur am Rohwert ändert (+ hochgesetzt, − abgesenkt; je Vorlauf und Windrichtung);
        Anteil = Gewicht 1/σ² in genau dieser Stunde. Die Summe der Anteile × korrigierten Werte ist
        der Konsens.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="py-1.5 pr-3 font-600">Modell</th>
              <th className="py-1.5 pr-3 text-right font-600">roh</th>
              <th className="py-1.5 pr-3 text-right font-600">
                <span className="sm:hidden">±</span>
                <span className="hidden sm:inline">Korrektur</span>
              </th>
              <th className="py-1.5 pr-3 text-right font-600">
                <span className="sm:hidden">korr.</span>
                <span className="hidden sm:inline">korrigiert</span>
              </th>
              <th className="py-1.5 pr-3 font-600">Anteil</th>
              <th className="py-1.5 pr-3 text-right font-600 normal-case" title="typischer Restfehler nach Korrektur, kalibriert">
                σ
              </th>
            </tr>
          </thead>
          <tbody>
            {withShare.map(({ m, raw, adj, sigma, share }) => {
              const corr = raw != null && adj != null ? adj - raw : null;
              const capped = corr != null && Math.abs(corr) >= maxCorr - 0.05;
              const floored = adj === 0 && raw != null && raw > 0;
              return (
                <tr key={m.idModel} className="border-t border-border-soft align-middle">
                  <td className="py-1.5 pr-3">
                    <span className="font-600 text-ink">{m.label}</span>
                    {m.resolution != null && <span className="ml-1.5 hidden text-[11px] text-faint sm:inline">{m.resolution} km</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-muted">{f(raw)}</td>
                  <td
                    className="py-1.5 pr-3 text-right font-mono"
                    style={{ color: capped || floored ? "var(--wg-amber)" : "var(--color-body)" }}
                    title={
                      capped
                        ? `Gekappt: je Stunde höchstens ±${maxCorr} kn Korrektur`
                        : floored
                          ? "Korrigierter Wert wäre negativ — auf 0 begrenzt"
                          : undefined
                    }
                  >
                    {corr == null || Math.abs(corr) < 0.05 ? "±0" : f(corr, true)}
                    {(capped || floored) && " ⚠"}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-ink">{f(adj)}</td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[color:var(--color-bg-2)] sm:block">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${(share / maxShare) * 100}%` }} />
                      </div>
                      <span className="font-mono text-[11px] text-muted">{(share * 100).toFixed(0)} %</span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-muted">{f(sigma)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border">
              <td className="py-1.5 pr-3 font-600 text-ink">Konsens</td>
              <td />
              <td />
              <td className="py-1.5 pr-3 text-right font-mono font-700 text-ink">{f(point.windspd)}</td>
              <td className="py-1.5 pr-3 text-[11px] text-muted" colSpan={2}>
                {withShare.length} Modelle
              </td>
            </tr>
            {Math.abs(off) >= 0.05 && (
              <tr>
                <td className="py-1 pr-3 text-muted" colSpan={3}>
                  + Kurzfrist-Korrektur aus der Messung
                </td>
                <td className="py-1 pr-3 text-right font-mono text-body">{f(off, true)}</td>
                <td className="py-1 pr-3 text-[11px] text-faint" colSpan={2}>
                  klingt ab
                </td>
              </tr>
            )}
            {Math.abs(off) >= 0.05 && (
              <tr>
                <td className="py-1 pr-3 font-600 text-ink" colSpan={3}>
                  Angezeigt im Cockpit
                </td>
                <td className="py-1 pr-3 text-right font-mono font-700 text-ink">
                  {f(point.windspd == null ? null : Math.max(0, point.windspd + off))}
                </td>
                <td colSpan={2} />
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-muted">
        Werte in {U}. P(≥ {TH.min} kn) für diese Stunde:{" "}
        <span className="font-mono text-body">{pMin == null ? "–" : `${Math.round(pMin * 100)} %`}</span>
        {" "}— jedes Modell trägt eine Normalverteilung mit seinem σ bei, gewichtet wie oben.
      </p>

      {missing.length > 0 && (
        <p className="mt-1 text-[11px] text-faint">
          Nicht dabei (keine Daten für diese Stunde):{" "}
          {missing
            .map((m) =>
              m.coverEnd != null && m.coverEnd < t
                ? `${m.label} (reicht bis ${whenFmt.format(new Date(m.coverEnd * 1000))})`
                : `${m.label} (Lauf beginnt später)`,
            )
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
