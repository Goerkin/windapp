"use client";
import { useMemo, useState } from "react";
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
import { PALETTE, MODEL_COLORS } from "@/lib/palette";
import { fmtTime, dayKeyOf, windBands } from "./ui";

const TZ = "Europe/Amsterdam";

const CAT_LABEL: Record<string, string> = {
  mesoscale: "hochauflösend",
  "regional-hi": "regional",
  global: "global",
};
const CAT_COLOR: Record<string, string> = {
  mesoscale: "#22d3ee",
  "regional-hi": "#a78bfa",
  global: "#f59e0b",
};

export default function ModelPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const [count, setCount] = useState(6);
  // Tages-Fokus: null = die nächsten 3 Tage am Stück; sonst genau dieser Tag.
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const days = spot.trend.daily.slice(0, 16);
  // Isolierte Modelle: leere Auswahl = alle zeigen; sonst nur die gewählten (+ Konsens).
  // In einem Set gehalten; per Klick auf die Legende umgeschaltet.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const topModels = spot.models.slice(0, count);

  // Nur Auswahl berücksichtigen, die auch im aktuellen Top-N-Pool liegt.
  const topIds = new Set(topModels.map((m) => m.idModel));
  const sel = new Set([...selected].filter((id) => topIds.has(id)));
  const isShown = (idModel: number) => sel.size === 0 || sel.has(idModel);
  const shownModels = topModels.filter((m) => isShown(m.idModel));

  const toggle = (idModel: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idModel)) next.delete(idModel);
      else next.add(idModel);
      return next;
    });

  const { data, midnights } = useMemo(() => {
    const now = Date.now() / 1000;
    const end = now + 72 * 3600;
    const idx = spot.gridTimes
      .map((t, i) => ({ t, i }))
      .filter((x) => (dayFilter ? dayKeyOf(x.t) === dayFilter : x.t <= end));

    const data = idx.map(({ t, i }) => {
      const row: Record<string, number | null> = { t };
      const cp = spot.points[i];
      row.consensus = convertWind(cp?.windspd ?? null, unit);
      topModels.forEach((m) => {
        row[`m${m.idModel}`] = convertWind(m.wind[i] ?? null, unit);
      });
      return row;
    });

    // Tagesgrenzen + Wochentag-Label für die Zeitachse (damit man den Tag ablesen kann).
    const midnights: { t: number; label: string }[] = [];
    const dayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short" });
    let last = "";
    for (const { t } of idx) {
      const k = dayKeyOf(t);
      if (k !== last) {
        midnights.push({ t, label: dayFmt.format(new Date(t * 1000)) });
        last = k;
      }
    }
    return { data, midnights };
  }, [spot.gridTimes, spot.points, topModels, unit, dayFilter]);

  const nowSec = Date.now() / 1000;

  return (
    <div>
      {/* Tages-Navigation: „3 Tage" am Stück oder ein einzelner Tag im Fokus. */}
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        <DayBtn active={dayFilter === null} onClick={() => setDayFilter(null)}>
          3 Tage
        </DayBtn>
        {days.map((d) => (
          <DayBtn key={d.day} active={dayFilter === d.day} onClick={() => setDayFilter(d.day)}>
            {d.label}
          </DayBtn>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-muted">
          Alle Modelle vs. Konsens · Wind ({unitLabel(unit)}) ·{" "}
          {dayFilter ? days.find((d) => d.day === dayFilter)?.label ?? "Tag" : "nächste 3 Tage"}
        </span>
        <div className="seg">
          {[4, 6, 10].map((c) => (
            <button key={c} data-active={count === c} onClick={() => setCount(c)}>
              Top {c}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 22, right: 6, bottom: 4, left: -18 }}>
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
          {/* Tagestrenner mit Wochentag — nur in der Mehrtages-Ansicht. */}
          {dayFilter === null &&
            midnights.map((m) => (
              <ReferenceLine
                key={m.t}
                className="ref-chrome"
                x={m.t}
                stroke={PALETTE.axisLine}
                strokeDasharray="3 3"
                label={{
                  value: m.label,
                  position: "insideTopLeft",
                  fill: PALETTE.axis,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              />
            ))}
          <ReferenceLine x={nowSec} stroke="#22d3ee" strokeOpacity={0.6} />
          {topModels.map((m, i) =>
            isShown(m.idModel) ? (
              <Line
                key={m.idModel}
                type="monotone"
                dataKey={`m${m.idModel}`}
                stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
                strokeWidth={sel.size ? 2 : 1.3}
                dot={false}
                isAnimationActive={false}
                connectNulls
                opacity={sel.size ? 1 : 0.85}
              />
            ) : null,
          )}
          <Line
            type="monotone"
            dataKey="consensus"
            className="line-consensus"
            stroke={PALETTE.axis}
            strokeWidth={2.6}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Tooltip content={<ModelTooltip models={shownModels} unit={unit} />} />
        </LineChart>
      </ResponsiveContainer>

      {/* Legende — Modelle anklickbar: nur das/die Gewählte(n) zeigen. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-body">
          <span className="inline-block h-0.5 w-5 rounded bg-white" /> Konsens
        </span>
        {topModels.map((m, i) => {
          const active = isShown(m.idModel);
          return (
            <button
              key={m.idModel}
              onClick={() => toggle(m.idModel)}
              aria-pressed={sel.has(m.idModel)}
              title={active ? `${m.label} ausblenden` : `nur ${m.label} zeigen`}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-opacity hover:bg-[color:var(--color-bg-2)]"
              style={{ opacity: active ? 1 : 0.35, cursor: "pointer" }}
            >
              <span
                className="inline-block h-0.5 w-5 rounded"
                style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
              />
              <span className={sel.has(m.idModel) ? "text-body" : "text-muted"}>{m.label}</span>
            </button>
          );
        })}
        {sel.size > 0 && (
          <button
            onClick={() => setSelected(new Set())}
            className="chip hover:border-accent"
            style={{ cursor: "pointer" }}
          >
            Alle zeigen
          </button>
        )}
      </div>

      {/* Modell-Erklärungen + Gewichte */}
      <div className="mt-5">
        <div className="mb-2 text-xs uppercase tracking-wider text-muted">
          Relevanteste Modelle für diesen Spot
        </div>
        <div className="space-y-2">
          {spot.models.slice(0, count).map((m) => (
            <div key={m.idModel} className="rounded-xl border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-600 text-ink">{m.label}</span>
                  <span
                    className="chip"
                    style={{ color: CAT_COLOR[m.category], borderColor: CAT_COLOR[m.category] + "40" }}
                  >
                    {CAT_LABEL[m.category] ?? m.category}
                  </span>
                  {m.resolution != null && (
                    <span className="text-[11px] text-faint">{m.resolution} km</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  {m.mae != null && (
                    <span className="text-faint" title="Ø Fehler gegen die Messung (recency-gewichtet)">
                      Ø {unit === "ms" ? (m.mae * 0.514444).toFixed(1) + " m/s" : Math.round(m.mae) + " kn"}
                    </span>
                  )}
                  <span className="text-muted" title="Anteil am eigenen Konsens (aus der Güte)">
                    {(m.weight * 100).toFixed(0)} %
                  </span>
                </div>
              </div>
              {/* Gewichts-Balken */}
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-bg-2)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, m.weight * 100 * 3)}%`, background: CAT_COLOR[m.category] }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted">{m.note}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DayBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-600 transition-colors"
      style={{
        borderColor: active ? "var(--color-accent)" : "var(--color-border)",
        background: active ? "var(--tint-accent)" : "transparent",
        color: active ? "var(--color-ink)" : "var(--color-muted)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function ModelTooltip({
  active,
  payload,
  models,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: Record<string, number | null> }>;
  models: { idModel: number; label: string }[];
  unit: WindUnit;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const t = row.t as unknown as number;
  const fmt = (v: number | null) => (v == null ? "–" : unit === "ms" ? v.toFixed(1) : String(Math.round(v)));
  const when = new Intl.DateTimeFormat("de-DE", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t * 1000));
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="mb-1 font-600 text-ink">{when}</div>
      <div className="text-body">
        Konsens <span className="font-mono text-ink">{fmt(row.consensus)}</span> {unitLabel(unit)}
      </div>
      {models.map((m) => (
        <div key={m.idModel} className="text-muted">
          {m.label}: <span className="font-mono">{fmt(row[`m${m.idModel}`])}</span>
        </div>
      ))}
    </div>
  );
}
