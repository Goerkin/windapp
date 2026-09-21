"use client";
import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotPayload, StationView } from "@/lib/types";
import { convertWind, unitLabel, compass, type WindUnit } from "@/lib/units";
import { PALETTE, ktColorHex } from "@/lib/palette";
import { nowcastOffsetAt, nowcastCutoff, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { fmtTime, windBands } from "./ui";

const TZ = "Europe/Amsterdam";
const HORIZONS = [
  { h: 72, label: "3 T" },
  { h: 120, label: "5 T" },
  { h: 240, label: "10 T" },
  { h: 384, label: "16 T" },
];

// Farben der gemessenen Linien (je Station) — deutlich abgesetzt von der teal Prognose.
const STATION_COLORS = ["#f472b6", "#fbbf24", "#34d399"];
const stColor = (i: number) => STATION_COLORS[i % STATION_COLORS.length];

type Row = Record<string, number | (number | null)[] | boolean | null>;

const NOWCAST_COLOR = "#fde047";
const PAST_COLOR = "#cbd5e1";

export default function ForecastChart({
  spot,
  unit,
  th,
  hours,
  days,
}: {
  spot: SpotPayload;
  unit: WindUnit;
  th: Thresholds;
  hours: HourEval[];
  days: DaySummary[];
}) {
  const [horizon, setHorizon] = useState(72);

  const stations = spot.stations ?? [];
  const shownStations = stations
    .map((s, i) => ({ st: s, i }))
    .filter(({ st }) => st.series.length > 0);

  const { data, midnights } = useMemo(() => {
    const now = Date.now() / 1000;
    const end = now + horizon * 3600;
    const conv = (v: number | null) => convertWind(v, unit);
    const cutoff = nowcastCutoff(spot);

    // Prognose (ab jetzt in die Zukunft). `nowcast` = Konsens + abklingende Mess-Abweichung,
    // nur solange sie spürbar ist (≥ 0.5 kn).
    const fRows: Row[] = spot.points
      .filter((p) => p.t <= end)
      .map((p) => {
        const off = nowcastOffsetAt(spot.nowcast, p.t, cutoff);
        return {
          t: p.t,
          wind: conv(p.windspd),
          gust: conv(p.gust),
          dir: p.winddir,
          nowcast: p.windspd != null && Math.abs(off) >= 0.5 ? conv(Math.max(0, p.windspd + off)) : null,
          windKt: p.windspd,
          arrow: Math.floor(p.t / 3600) % 6 === 0,
        };
      });
    // Messpunkt als Startpunkt der Korrekturlinie.
    if (spot.nowcast) {
      fRows.push({ t: spot.nowcast.t0, nowcast: conv(spot.nowcast.measured) });
    }

    // Prognose von vor ~24 h: über die Messung gelegt und weiter in die Zukunft.
    const pRows: Row[] = (spot.pastForecast?.points ?? [])
      .filter((p) => p.t <= end)
      .map((p) => ({ t: p.t, past: conv(p.wind) }));

    // Gemessen: je Station eine Reihe von Punkten (meist in der Vergangenheit).
    const mRows: Row[] = [];
    stations.forEach((st, i) => {
      for (const o of st.series) {
        mRows.push({
          t: o.t,
          [`m${i}w`]: conv(o.windAvg),
          [`m${i}g`]: conv(o.windMax),
          [`m${i}d`]: o.windDir,
        });
      }
    });

    const data = [...mRows, ...pRows, ...fRows].sort((a, b) => (a.t as number) - (b.t as number));

    // Mitternachtsgrenzen (lokale Zeit) für Tagestrenner — über den gesamten Bereich.
    const midnights: { t: number; label: string }[] = [];
    const dayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short" });
    let lastDay = "";
    for (const r of data) {
      const t = r.t as number;
      const key = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(t * 1000));
      if (key !== lastDay) {
        midnights.push({ t, label: dayFmt.format(new Date(t * 1000)) });
        lastDay = key;
      }
    }
    return { data, midnights };
  }, [spot, stations, horizon, unit]);

  // Wahrscheinlichkeit P(≥ Mindestwind) je Stunde als Balkenstreifen unter dem Chart.
  const probData = useMemo(() => {
    const end = Date.now() / 1000 + horizon * 3600;
    return hours
      .filter((h) => h.t <= end)
      .map((h) => ({ t: h.t, p: h.pMin == null ? null : Math.round(h.pMin * 100), ride: h.rideable, day: h.daylight }));
  }, [hours, horizon]);

  const windows = useMemo(() => days.flatMap((d) => d.windows), [days]);
  // Ab hier rechnen nur noch globale Modelle (erste Stunde ohne hochauflösendes Modell).
  const globalFrom = hours.find((h) => !h.hiRes)?.t ?? null;

  if (!data.length) return <p className="text-sm text-muted">Keine Verlaufsdaten.</p>;

  const nowSec = Date.now() / 1000;
  const firstT = data[0].t as number;
  const lastT = data[data.length - 1].t as number;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-muted">Konsens · Wind & Böen in {unitLabel(unit)}</span>
        <div className="seg">
          {HORIZONS.map((o) => (
            <button key={o.h} data-active={horizon === o.h} onClick={() => setHorizon(o.h)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 24, right: 6, bottom: 4, left: -18 }}>
          <CartesianGrid stroke={PALETTE.gridLine} strokeDasharray="2 4" vertical={false} />
          {windBands(unit)}
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) => fmtTime(t)}
            ticks={midnights.map((m) => m.t)}
            tick={{ fontSize: 12, fill: PALETTE.axis }}
            stroke={PALETTE.axisLine}
            tickLine={{ stroke: PALETTE.axisLine }}
          />
          <YAxis
            tick={{ fontSize: 12, fill: PALETTE.axis }}
            stroke={PALETTE.axisLine}
            tickLine={{ stroke: PALETTE.axisLine }}
            width={40}
          />

          {/* Fahrbare Fenster */}
          {windows.map((w) => (
            <ReferenceArea
              key={w.start}
              x1={Math.max(w.start, firstT)}
              x2={Math.min(w.end - 3600, lastT)}
              fill={PALETTE.green}
              fillOpacity={0.1}
              stroke="none"
              ifOverflow="hidden"
            />
          ))}
          {/* Nur noch globale Modelle → blasser Hintergrund */}
          {globalFrom != null && globalFrom <= lastT && (
            <ReferenceArea
              x1={Math.max(globalFrom, firstT)}
              x2={lastT}
              fill="#000"
              fillOpacity={0.22}
              stroke="none"
              ifOverflow="hidden"
              label={{ value: "nur globale Modelle", position: "insideBottomLeft", fill: PALETTE.muted, fontSize: 11 }}
            />
          )}
          <ReferenceLine
            y={convertWind(th.min, unit) ?? undefined}
            stroke={PALETTE.green}
            strokeOpacity={0.45}
            strokeDasharray="6 4"
          />

          {/* Tagestrenner */}
          {midnights.map((m) => (
            <ReferenceLine
              key={m.t}
              x={m.t}
              stroke={PALETTE.axisLine}
              strokeDasharray="3 3"
              label={{ value: m.label, position: "insideTopLeft", fill: PALETTE.axis, fontSize: 12, fontWeight: 600 }}
            />
          ))}
          {nowSec >= firstT && nowSec <= lastT && (
            <ReferenceLine x={nowSec} stroke="#22d3ee" strokeWidth={1} strokeOpacity={0.6} />
          )}

          <Line
            type="monotone"
            dataKey="gust"
            stroke={PALETTE.gust}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
            name="Böen"
          />
          <Line
            type="monotone"
            dataKey="wind"
            stroke={PALETTE.teal}
            strokeWidth={2.4}
            isAnimationActive={false}
            connectNulls
            name="Wind"
            dot={<DirDot />}
            activeDot={{ r: 4 }}
          />

          {/* Damalige Prognose (vor ~24 h) — zum Abgleich mit der Messung */}
          <Line
            type="monotone"
            dataKey="past"
            stroke={PAST_COLOR}
            strokeWidth={1.6}
            strokeDasharray="6 3"
            strokeOpacity={0.8}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />

          {/* Kurzfrist-Korrektur aus der Messung (klingt über wenige Stunden ab) */}
          <Line
            type="monotone"
            dataKey="nowcast"
            stroke={NOWCAST_COLOR}
            strokeWidth={2}
            strokeDasharray="2 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />

          {/* Gemessen je Station — liegt links von „jetzt" gegen die Prognose. */}
          {shownStations.map(({ i }) => (
            <Line
              key={`g${i}`}
              type="monotone"
              dataKey={`m${i}g`}
              stroke={stColor(i)}
              strokeWidth={1.3}
              strokeDasharray="4 3"
              strokeOpacity={0.6}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {shownStations.map(({ i }) => (
            <Line
              key={`w${i}`}
              type="monotone"
              dataKey={`m${i}w`}
              stroke={stColor(i)}
              strokeWidth={2.4}
              dot={{ r: 1.6, fill: stColor(i), strokeWidth: 0 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          <Tooltip content={<ChartTooltip unit={unit} stations={stations} />} />
        </ComposedChart>
      </ResponsiveContainer>

      {/* P(≥ Mindestwind) je Stunde */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
        <span>
          Wahrscheinlichkeit für ≥ {convertWind(th.min, unit)} {unitLabel(unit)} (kalibriert)
        </span>
        <span className="text-faint">grün = fahrbares Fenster</span>
      </div>
      <ResponsiveContainer width="100%" height={56}>
        <ComposedChart data={probData} margin={{ top: 8, right: 6, bottom: 0, left: -18 }}>
          <XAxis dataKey="t" type="number" scale="time" domain={[firstT, lastT]} hide allowDataOverflow />
          <YAxis domain={[0, 100]} ticks={[0, 50]} tick={{ fontSize: 10, fill: PALETTE.muted }} width={40} stroke={PALETTE.axisLine} />
          <ReferenceLine y={50} stroke={PALETTE.axisLine} strokeDasharray="2 3" />
          <Bar dataKey="p" isAnimationActive={false}>
            {probData.map((d) => (
              <Cell
                key={d.t}
                fill={d.ride ? PALETTE.green : PALETTE.muted}
                fillOpacity={d.ride ? 0.85 : d.day ? 0.45 : 0.18}
              />
            ))}
          </Bar>
          <Tooltip content={<ProbTooltip />} cursor={{ fill: "rgba(255,255,255,.05)" }} />
        </ComposedChart>
      </ResponsiveContainer>

      <Legend stations={stations} hasNowcast={!!spot.nowcast} past={spot.pastForecast} unit={unit} />
    </div>
  );
}

function ProbTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { t: number; p: number | null; ride: boolean } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-1.5 text-xs">
      <span className="text-ink">
        {new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(
          new Date(d.t * 1000),
        )}
      </span>{" "}
      · <span className="font-mono text-ink">{d.p ?? "–"} %</span>
      {d.ride && <span className="ml-1 text-[color:var(--wg-green)]">fahrbar</span>}
    </div>
  );
}

// Richtungspfeil als Punkt auf der Wind-Linie (alle 6 h).
function DirDot(props: {
  cx?: number;
  cy?: number;
  payload?: { dir: number | null; windKt: number | null; arrow?: boolean };
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.dir == null || !payload?.arrow) {
    return <g />;
  }
  const color = ktColorHex(payload.windKt ?? null);
  return (
    <g transform={`translate(${cx}, ${cy - 16}) rotate(${payload.dir + 180})`}>
      <path d="M0 -4 L3 5 L0 3 L-3 5 Z" fill={color} />
    </g>
  );
}

function ChartTooltip({
  active,
  payload,
  unit,
  stations,
}: {
  active?: boolean;
  payload?: Array<{ payload: Record<string, number | null> }>;
  unit?: WindUnit;
  stations?: StationView[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const u = unit ?? "kn";
  const fmt = (v: number | null | undefined) =>
    v == null ? "–" : u === "ms" ? v.toFixed(1) : String(Math.round(v));
  const t = p.t as number;
  const measuredIdx = (stations ?? [])
    .map((_, i) => i)
    .filter((i) => p[`m${i}w`] != null || p[`m${i}g`] != null);

  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="mb-1 font-600 text-ink">
        {new Intl.DateTimeFormat("de-DE", {
          timeZone: TZ,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(t * 1000))}
      </div>
      {p.past != null && (
        <div style={{ color: PAST_COLOR }}>
          Prognose von vor 24 h <span className="font-mono">{fmt(p.past)}</span> {unitLabel(u)}
        </div>
      )}
      {measuredIdx.length ? (
        measuredIdx.map((i) => (
          <div key={i}>
            <span style={{ color: stColor(i) }}>Gemessen · {stations?.[i]?.name}</span>{" "}
            <span className="font-mono text-ink">{fmt(p[`m${i}w`])}</span> · Böen{" "}
            <span className="font-mono text-ink">{fmt(p[`m${i}g`])}</span> {unitLabel(u)} ·{" "}
            {compass((p[`m${i}d`] as number) ?? null)}
          </div>
        ))
      ) : (
        <>
          <div className="text-body">
            Wind <span className="font-mono text-ink">{fmt(p.wind)}</span> · Böen{" "}
            <span className="font-mono text-ink">{fmt(p.gust)}</span> {unitLabel(u)}
          </div>
          {p.nowcast != null && (
            <div style={{ color: NOWCAST_COLOR }}>
              korrigiert nach Messung <span className="font-mono">{fmt(p.nowcast)}</span> {unitLabel(u)}
            </div>
          )}
          <div className="text-muted">
            {compass(p.dir)} ({p.dir ?? "–"}°)
          </div>
        </>
      )}
    </div>
  );
}

function Legend({
  stations,
  hasNowcast,
  past,
  unit,
}: {
  stations?: StationView[];
  hasNowcast?: boolean;
  past?: SpotPayload["pastForecast"];
  unit: WindUnit;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 rounded" style={{ background: PALETTE.teal }} /> Wind
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 rounded" style={{ background: PALETTE.gust }} /> Böen
      </span>
      {(stations ?? []).map((st, i) => (
        <span key={st.id} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: stColor(i) }} /> Gemessen ({st.name})
        </span>
      ))}
      {past && (
        <span
          className="flex items-center gap-1.5"
          title={`Konsens des Datenstands von ${new Date(past.fetchedAt).toLocaleString("de-DE", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" })}, mit heutiger Korrektur gerechnet`}
        >
          <span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: PAST_COLOR }} />
          Prognose von vor 24 h
          {past.mae != null && past.n >= 3 && (
            <span className="text-faint">
              (lag Ø {convertWind(past.mae, unit)} {unitLabel(unit)} daneben
              {past.bias != null && Math.abs(past.bias) >= 1 ? `, meist zu ${past.bias > 0 ? "hoch" : "niedrig"}` : ""})
            </span>
          )}
        </span>
      )}
      {hasNowcast && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: NOWCAST_COLOR }} /> korrigiert nach Messung
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-4 rounded-sm" style={{ background: PALETTE.green, opacity: 0.3 }} />
        Fahrfenster
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 border-t border-dashed" style={{ borderColor: PALETTE.green }} /> dein Mindestwind
      </span>
      <span>↑ Pfeile = Windrichtung (alle 6 h)</span>
      <span title="Hintergrund-Bänder: knapp (blau), fahrbar (türkis), gut (grün), kräftig (gelb), zu viel (orange/rot)">
        Hintergrund = Windbereiche wie die Kacheln
      </span>
    </div>
  );
}
