"use client";
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotPayload } from "@/lib/types";
import { convertWind, unitLabel, type WindUnit } from "@/lib/units";
import { PALETTE } from "@/lib/palette";
import { fmtTime, relTime, DeltaBadge, windBands } from "./ui";

const HORIZON_H = 120;

export default function TrendPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const runs = spot.trend.runs;

  const data = useMemo(() => {
    const now = Date.now() / 1000;
    const end = now + HORIZON_H * 3600;
    const idx = spot.gridTimes.map((t, i) => ({ t, i })).filter((x) => x.t <= end);
    return idx.map(({ t, i }) => {
      const row: Record<string, number | null> = { t };
      row.current = convertWind(spot.points[i]?.windspd ?? null, unit);
      runs.forEach((r, ri) => {
        row[`r${ri}`] = convertWind(r.wind[i] ?? null, unit);
      });
      return row;
    });
  }, [spot.gridTimes, spot.points, runs, unit]);

  const nowSec = Date.now() / 1000;
  // Ältere Läufe blasser (Reihenfolge: runs ist neu→alt).
  const runStyle = (ri: number) => {
    const frac = runs.length <= 1 ? 1 : ri / (runs.length - 1); // 0=neu, 1=alt
    return { opacity: 0.55 - frac * 0.35, color: "var(--color-faint)" };
  };

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        Wie sich der Wind-Forecast für die kommenden Tage über die letzten Datenstände
        verändert hat — im 3–6-h-Raster (dicht in den letzten ~2 Tagen, danach weiter). Eng
        beieinanderliegende Linien = stabile Vorhersage; auseinanderlaufende = die Modelle
        rechnen die Lage gerade um.
      </p>

      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4 text-sm text-muted">
          Noch keine Historie – der Trend baut sich auf, sobald mehrere Datenstände gesammelt
          wurden (der Server ruft regelmäßig ab). Schau in ein paar Stunden wieder rein.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 4, left: -18 }}>
            <CartesianGrid stroke={PALETTE.gridLine} strokeDasharray="2 4" vertical={false} />
            {windBands(unit)}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) => fmtTime(t)}
              tick={{ fontSize: 12, fill: PALETTE.axis }}
              stroke={PALETTE.axisLine}
              tickLine={{ stroke: PALETTE.axisLine }}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 12, fill: PALETTE.axis }}
              stroke={PALETTE.axisLine}
              tickLine={{ stroke: PALETTE.axisLine }}
              width={40}
            />
            <ReferenceLine x={nowSec} stroke="#22d3ee" strokeOpacity={0.6} />
            {runs.map((r, ri) => {
              const s = runStyle(ri);
              return (
                <Line
                  key={ri}
                  type="monotone"
                  dataKey={`r${ri}`}
                  stroke={s.color}
                  strokeWidth={1}
                  strokeOpacity={s.opacity}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              );
            })}
            <Line
              type="monotone"
              dataKey="current"
              stroke={PALETTE.teal}
              strokeWidth={2.6}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            <Tooltip content={<TrendTooltip runs={runs} unit={unit} />} />
          </LineChart>
        </ResponsiveContainer>
      )}

      {runs.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted">
          <span className="flex items-center gap-1.5 text-body">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: PALETTE.teal }} /> jetziger Stand
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded bg-faint" /> frühere Stände (blasser = älter)
          </span>
          {spot.trend.refFetchedAt && (
            <span>Historie zurück bis {relTime(spot.trend.refFetchedAt)}</span>
          )}
        </div>
      )}

      {/* Tages-Deltas als Tabelle: Spitze + Δ je Kadenz (6 h / 1 T / 3 T / 7 T) */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted">Tages-Spitze &amp; Änderung</span>
          <span className="text-[11px] text-faint">Δ 6 h · 1 T · 3 T · 7 T</span>
        </div>
        <div className="space-y-1">
          {spot.trend.daily.slice(0, 16).map((d) => (
            <div
              key={d.day}
              className="flex items-center justify-between gap-2 rounded-lg border border-border-soft px-3 py-1.5 text-sm"
            >
              <span className="shrink-0 text-body">{d.label}</span>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <span className="mr-1 text-muted">
                  <span className="font-mono text-ink">{fmtOne(d.peak, unit)}</span> {unitLabel(unit)}
                </span>
                {d.deltas.map((dl) => (
                  <DeltaBadge key={dl.key} delta={dl.delta} unit={unit} label={dl.label} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function fmtOne(kt: number | null, unit: WindUnit): string {
  const v = convertWind(kt, unit);
  return v == null ? "–" : unit === "ms" ? v.toFixed(1) : String(Math.round(v));
}

function TrendTooltip({
  active,
  payload,
  runs,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: Record<string, number | null> }>;
  runs: { fetchedAt: string }[];
  unit: WindUnit;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const t = row.t as unknown as number;
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="mb-1 font-600 text-ink">{fmtTime(t)}</div>
      <div className="text-body">
        jetzt <span className="font-mono text-ink">{fmtOne(row.current, unit)}</span> {unitLabel(unit)}
      </div>
      {runs.map((r, ri) =>
        row[`r${ri}`] == null ? null : (
          <div key={ri} className="text-muted">
            {relTime(r.fetchedAt)}: <span className="font-mono">{fmtOne(row[`r${ri}`], unit)}</span>
          </div>
        ),
      )}
    </div>
  );
}
