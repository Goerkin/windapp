"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotPayload, ModelVerification } from "@/lib/types";
import { convertWind, unitLabel, type WindUnit } from "@/lib/units";
import { PALETTE, MODEL_COLORS, stationColor } from "@/lib/palette";
import { fmtTime, relTime, windBands } from "./ui";

const MEASURED = stationColor(0); // wie die Messlinie im Verlauf

export default function ModelVerifyPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const [data, setData] = useState<ModelVerification | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(6);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(
    async (d?: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ spot: String(spot.id) });
        if (d) qs.set("day", d);
        const res = await fetch(`/api/model-verify?${qs}`, { cache: "no-store" });
        const json = await res.json();
        if (json.ok) {
          setData(json.data);
          setDay(json.data?.day ?? null);
        } else setError(json.error ?? "Fehler beim Laden");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [spot.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const topModels = useMemo(() => (data?.models ?? []).slice(0, count), [data, count]);
  const isShown = (id: number) => selected.size === 0 || selected.has(id);
  const toggle = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const chart = useMemo(() => {
    if (!data) return [];
    const conv = (v: number | null) => convertWind(v, unit);
    return data.gridTimes.map((t, i) => {
      const row: Record<string, number | null> = {
        t,
        measured: conv(data.measured[i] ?? null),
        consensus: conv(data.consensus[i] ?? null),
      };
      topModels.forEach((m) => (row[`m${m.idModel}`] = conv(m.wind[i] ?? null)));
      return row;
    });
  }, [data, topModels, unit]);

  const days = data?.days ?? [];
  const idx = days.findIndex((d) => d.day === day);
  const go = (delta: number) => {
    const j = idx + delta;
    if (j >= 0 && j < days.length) void load(days[j].day);
  };
  const curLabel = days.find((d) => d.day === day)?.label ?? "";

  return (
    <div>
      <div className="mb-1 text-xs text-muted">
        Vorhersage jedes Modells (Stand day-ahead) gegen die tatsächliche Messung — je Tag.
      </div>
      <p className="mb-3 text-[11px] text-faint">
        Prognose-Stand: {data?.refFetchedAt ? relTime(data.refFetchedAt) : "–"} · Modelle nach
        Tagesgenauigkeit sortiert (bestes zuerst). „Ø Fehler" = mittlerer Abstand zur Messung.
      </p>

      {/* Tages-Navigation */}
      <div className="mb-3 flex items-center gap-2">
        <button className="chip" onClick={() => go(-1)} disabled={idx <= 0} style={{ cursor: idx <= 0 ? "default" : "pointer" }}>
          ‹
        </button>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {days.map((d) => (
            <button
              key={d.day}
              onClick={() => void load(d.day)}
              className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-600 transition-colors"
              style={{
                borderColor: d.day === day ? "var(--color-accent)" : "var(--color-border)",
                background: d.day === day ? "var(--tint-accent)" : "transparent",
                color: d.day === day ? "var(--color-ink)" : "var(--color-muted)",
                cursor: "pointer",
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
        <button
          className="chip"
          onClick={() => go(1)}
          disabled={idx < 0 || idx >= days.length - 1}
          style={{ cursor: idx >= days.length - 1 ? "default" : "pointer" }}
        >
          ›
        </button>
      </div>

      {loading && <p className="text-sm text-muted">lädt…</p>}
      {error && <p className="text-sm" style={{ color: "var(--wg-red)" }}>Fehler: {error}</p>}

      {!loading && !error && data && chart.length > 0 && (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted">
              {curLabel} · Wind ({unitLabel(unit)}) · Modelle vs. Messung
            </span>
            <div className="seg">
              {[4, 6, 10].map((c) => (
                <button key={c} data-active={count === c} onClick={() => setCount(c)}>
                  Top {c}
                </button>
              ))}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chart} margin={{ top: 6, right: 6, bottom: 4, left: -18 }}>
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
                minTickGap={30}
              />
              <YAxis
                tick={{ fontSize: 12, fill: PALETTE.axis }}
                stroke={PALETTE.axisLine}
                tickLine={{ stroke: PALETTE.axisLine }}
                width={40}
              />
              {topModels.map((m, i) =>
                isShown(m.idModel) ? (
                  <Line
                    key={m.idModel}
                    type="monotone"
                    dataKey={`m${m.idModel}`}
                    stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
                    strokeWidth={selected.size ? 2 : 1.2}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                    opacity={selected.size ? 1 : 0.8}
                  />
                ) : null,
              )}
              <Line
                type="monotone"
                dataKey="consensus"
                className="line-consensus"
            stroke={PALETTE.axis}
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="measured"
                stroke={MEASURED}
                strokeWidth={2.8}
                dot={{ r: 1.8, fill: MEASURED, strokeWidth: 0 }}
                isAnimationActive={false}
                connectNulls
              />
              <Tooltip content={<VTooltip models={topModels} unit={unit} />} />
            </LineChart>
          </ResponsiveContainer>

          {/* Legende mit Tages-MAE, anklickbar zum Isolieren */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="flex items-center gap-1.5 text-body">
              <span className="inline-block h-0.5 w-5 rounded" style={{ background: MEASURED }} /> Gemessen
            </span>
            <span className="flex items-center gap-1.5 text-muted">
              <span className="inline-block h-0.5 w-5 rounded bg-white" /> Konsens
            </span>
            {topModels.map((m, i) => (
              <button
                key={m.idModel}
                onClick={() => toggle(m.idModel)}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-opacity hover:bg-[color:var(--color-bg-2)]"
                style={{ opacity: isShown(m.idModel) ? 1 : 0.35, cursor: "pointer" }}
                title={isShown(m.idModel) ? `${m.label} ausblenden` : `nur ${m.label} zeigen`}
              >
                <span
                  className="inline-block h-0.5 w-5 rounded"
                  style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
                />
                <span className={selected.has(m.idModel) ? "text-body" : "text-muted"}>
                  {m.label}
                </span>
                {m.mae != null && (
                  <span className="text-faint">
                    · Ø {unit === "ms" ? (m.mae * 0.514444).toFixed(1) : Math.round(m.mae)}{" "}
                    {unit === "ms" ? "m/s" : "kn"}
                  </span>
                )}
              </button>
            ))}
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="chip hover:border-accent" style={{ cursor: "pointer" }}>
                Alle zeigen
              </button>
            )}
          </div>
        </>
      )}

      {!loading && !error && data && chart.length === 0 && (
        <p className="text-sm text-muted">Für diesen Tag liegen noch keine Messungen vor.</p>
      )}
    </div>
  );
}

function VTooltip({
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
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="mb-1 font-600 text-ink">{fmtTime(t)}</div>
      <div style={{ color: MEASURED }}>
        Gemessen <span className="font-mono">{fmt(row.measured)}</span> {unitLabel(unit)}
      </div>
      <div className="text-body">
        Konsens <span className="font-mono">{fmt(row.consensus)}</span>
      </div>
      {models.map((m) => (
        <div key={m.idModel} className="text-muted">
          {m.label}: <span className="font-mono">{fmt(row[`m${m.idModel}`])}</span>
        </div>
      ))}
    </div>
  );
}
