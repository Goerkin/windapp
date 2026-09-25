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
import { PALETTE, SERIES, SERIES_CLASS, SERIES_FALLBACK, ktColor, stationClass, stationColor, stationFallback } from "@/lib/palette";
import { nowcastOffsetAt, nowcastCutoff, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { dayKeyOf, hourOf, useWide, windBands } from "./ui";
import { fmtWeekday, fmtWeekdayTime } from "@/lib/dates";

const HORIZONS = [
  { h: 72, label: "3 T" },
  { h: 120, label: "5 T" },
  { h: 240, label: "10 T" },
  { h: 384, label: "16 T" },
];

// Glättung der Messung: Mittel über ±SMOOTH_S. Die Windguru-Stationen liefern 10-min-Werte;
// ungeglättet zappelt die Linie so stark, dass man den Verlauf gegen die Prognose kaum sieht.
const SMOOTH_S = 20 * 60;

type Row = Record<string, number | (number | null)[] | boolean | null>;

// Beschriftete Uhrzeiten der x-Achse. Früher stand dort 00:00 — die Uhrzeit, die beim Kiten am
// wenigsten interessiert; die Tagesgrenzen tragen schon die Wochentage. Breit: bis 5 Tage
// 6/12/18 Uhr, darüber Mittag. Schmal (Handy): bis 5 Tage Mittag, darüber nichts — sonst ließ
// Recharts einzelne Werte weg und es blieben unregelmäßige „12 18"-Paare.
const tickHours = (horizonH: number, wide: boolean) =>
  horizonH <= 120 ? (wide ? [6, 12, 18] : [12]) : wide ? [12] : [];

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
  const wide = useWide();

  // useMemo, weil `?? []` sonst bei jedem Render ein neues Array liefert und die useMemo
  // weiter unten dadurch nie greift.
  const stations = useMemo(() => spot.stations ?? [], [spot.stations]);
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

    // Gemessen: je Station geglättet (Hauptlinie) und roh (blass dahinter).
    const mRows: Row[] = [];
    stations.forEach((st, i) => {
      const smooth = (k: "windAvg" | "windMax", t: number) => {
        let sum = 0;
        let n = 0;
        for (const o of st.series) {
          const v = o[k];
          if (v != null && Math.abs(o.t - t) <= SMOOTH_S) {
            sum += v;
            n++;
          }
        }
        return n ? sum / n : null;
      };
      for (const o of st.series) {
        mRows.push({
          t: o.t,
          [`m${i}w`]: conv(smooth("windAvg", o.t)),
          [`m${i}r`]: conv(o.windAvg),
          [`m${i}g`]: conv(smooth("windMax", o.t)),
          [`m${i}d`]: o.windDir,
        });
      }
    });

    const data = [...mRows, ...pRows, ...fRows].sort((a, b) => (a.t as number) - (b.t as number));

    // Mitternachtsgrenzen (lokale Zeit) für Tagestrenner — über den gesamten Bereich.
    const midnights: { t: number; label: string }[] = [];
    let lastDay = "";
    for (const r of data) {
      const t = r.t as number;
      const key = dayKeyOf(t);
      if (key !== lastDay) {
        midnights.push({ t, label: fmtWeekday(t) });
        lastDay = key;
      }
    }
    // Wochentag nur, wo das Stück bis zur nächsten Grenze breit genug ist — sonst standen am
    // Handy „Do" und „Fr" übereinander (der erste, angeschnittene Tag ist oft nur Stunden lang).
    if (data.length) {
      const span = (data[data.length - 1].t as number) - (data[0].t as number);
      const minSeg = Math.max(8 * 3600, 0.04 * span);
      midnights.forEach((m, k) => {
        const next = midnights[k + 1]?.t ?? (data[data.length - 1].t as number);
        if (next - m.t < minSeg) m.label = "";
      });
    }
    return { data, midnights };
  }, [spot, stations, horizon, unit]);

  // Streifen unter dem Diagramm: P(≥ Mindestwind) je Stunde als Deckkraft (grün = Fahrfenster)
  // und darüber die Windrichtung als Pfeilzeile — statt kleiner Pfeile auf der Windlinie.
  const probData = useMemo(() => {
    const end = Date.now() / 1000 + horizon * 3600;
    // Pfeil-Abstand je Zeitraum, damit sie sich auch auf dem Handy nicht überlappen.
    const every = horizon <= 72 ? 6 : horizon <= 120 ? 12 : 24;
    return hours
      .filter((h) => h.t <= end)
      .map((h) => ({
        t: h.t,
        p: h.pMin == null ? null : Math.round(h.pMin * 100),
        one: 1,
        ride: h.rideable,
        day: h.daylight,
        arrowY: Math.floor(h.t / 3600) % every === 0 && h.dir != null ? 1.55 : null,
        dir: h.dir,
        windKt: h.wind,
      }));
  }, [hours, horizon]);

  const windows = useMemo(() => days.flatMap((d) => d.windows), [days]);
  // Ab hier rechnen nur noch globale Modelle (erste Stunde ohne hochauflösendes Modell).
  const globalFrom = hours.find((h) => !h.hiRes)?.t ?? null;

  if (!data.length) return <p className="text-sm text-muted">Keine Verlaufsdaten.</p>;

  const nowSec = Date.now() / 1000;
  const firstT = data[0].t as number;
  const lastT = data[data.length - 1].t as number;
  const want = tickHours(horizon, wide);
  const ticks: number[] = [];
  for (let t = Math.ceil(firstT / 3600) * 3600; t <= lastT; t += 3600) if (want.includes(hourOf(t))) ticks.push(t);

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
            tickFormatter={(t) => String(hourOf(t)).padStart(2, "0")}
            ticks={ticks}
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
            className="ref-min"
            stroke={PALETTE.teal}
            strokeOpacity={0.6}
            strokeDasharray="6 4"
            label={{ value: `ab ${convertWind(th.min, unit)}`, position: "insideBottomRight", fill: PALETTE.axis, fontSize: 10 }}
          />

          {/* Tagestrenner */}
          {midnights.map((m) => (
            <ReferenceLine
              key={m.t}
              className="ref-chrome"
              x={m.t}
              stroke={PALETTE.axisLine}
              strokeDasharray="3 3"
              label={m.label ? { value: m.label, position: "insideTopLeft", fill: PALETTE.axis, fontSize: 12, fontWeight: 600 } : undefined}
            />
          ))}
          {nowSec >= firstT && nowSec <= lastT && (
            <ReferenceLine x={nowSec} className="ref-now" stroke={PALETTE.axisLine} strokeWidth={1} />
          )}

          <Line
            type="monotone"
            dataKey="gust"
            className={SERIES_CLASS.gust}
            stroke={SERIES_FALLBACK.gust}
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
            className={SERIES_CLASS.wind}
            stroke={SERIES_FALLBACK.wind}
            strokeWidth={2.4}
            isAnimationActive={false}
            connectNulls
            name="Wind"
            dot={false}
            activeDot={{ r: 4, style: { fill: SERIES.wind } }}
          />

          {/* Damalige Prognose (vor ~24 h) — zum Abgleich mit der Messung */}
          <Line
            type="monotone"
            dataKey="past"
            className={SERIES_CLASS.past}
            stroke={SERIES_FALLBACK.past}
            strokeWidth={1.6}
            strokeDasharray="6 3"
            strokeOpacity={0.8}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />

          {/* Kurzfrist-Korrektur aus der Messung (klingt über wenige Stunden ab) — die Windlinie,
              gepunktet. Früher Gelb, das gehört der Windskala („kräftig"). */}
          <Line
            type="monotone"
            dataKey="nowcast"
            className={SERIES_CLASS.wind}
            stroke={SERIES_FALLBACK.wind}
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
              className={stationClass(i)}
              stroke={stationFallback(i)}
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
              key={`r${i}`}
              type="linear"
              dataKey={`m${i}r`}
              className={stationClass(i)}
              stroke={stationFallback(i)}
              strokeWidth={1}
              strokeOpacity={0.3}
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
              className={stationClass(i)}
              stroke={stationFallback(i)}
              strokeWidth={2.4}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          <Tooltip content={<ChartTooltip unit={unit} stations={stations} />} />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Richtung + P(≥ Mindestwind) je Stunde als Streifen, auf derselben Zeitachse */}
      <ResponsiveContainer width="100%" height={40}>
        <ComposedChart data={probData} margin={{ top: 0, right: 6, bottom: 0, left: -18 }} barCategoryGap={0}>
          <XAxis dataKey="t" type="number" scale="time" domain={[firstT, lastT]} hide allowDataOverflow />
          <YAxis domain={[0, 2]} hide width={40} />
          <Bar dataKey="one" isAnimationActive={false} maxBarSize={12}>
            {probData.map((d) => (
              <Cell
                key={d.t}
                fill={d.ride ? PALETTE.green : PALETTE.muted}
                fillOpacity={d.p == null ? 0 : d.ride ? 0.35 + 0.6 * (d.p / 100) : (d.day ? 0.08 : 0.03) + 0.6 * (d.p / 100)}
              />
            ))}
          </Bar>
          <Line dataKey="arrowY" stroke="none" dot={<DirDot />} activeDot={false} isAnimationActive={false} />
          <Tooltip content={<ProbTooltip />} cursor={{ fill: "var(--tint-neutral)" }} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-1 text-[11px] text-faint">
        Pfeile: Windrichtung · Streifen: Wahrscheinlichkeit für ≥ {convertWind(th.min, unit)} {unitLabel(unit)} (je
        dunkler, desto sicherer; grün = Fahrfenster)
      </div>

      <Legend stations={stations} hasNowcast={!!spot.nowcast} past={spot.pastForecast} unit={unit} />
    </div>
  );
}

function ProbTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { t: number; p: number | null; ride: boolean } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-1.5 text-xs">
      <span className="text-ink">{fmtWeekdayTime(d.t)}</span>{" "}
      · <span className="font-mono text-ink">{d.p ?? "–"} %</span>
      {d.ride && <span className="ml-1 text-[color:var(--wg-green)]">fahrbar</span>}
    </div>
  );
}

// Richtungspfeil in der Pfeilzeile unter dem Diagramm (Farbe = Windstärke).
function DirDot(props: {
  cx?: number;
  cy?: number;
  payload?: { dir: number | null; windKt: number | null; arrowY?: number | null };
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.dir == null || payload?.arrowY == null) {
    return <g />;
  }
  const color = ktColor(payload.windKt ?? null);
  return (
    <g transform={`translate(${cx}, ${cy}) rotate(${payload.dir + 180})`}>
      <path d="M0 -6 L4.5 6 L0 3.5 L-4.5 6 Z" style={{ fill: color }} />
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
      <div className="mb-1 font-600 text-ink">{fmtWeekdayTime(t)}</div>
      {p.past != null && (
        <div style={{ color: SERIES.past }}>
          Prognose von vor 24&nbsp;h <span className="font-mono">{fmt(p.past)}</span> {unitLabel(u)}
        </div>
      )}
      {measuredIdx.length ? (
        measuredIdx.map((i) => (
          <div key={i}>
            <span style={{ color: stationColor(i) }}>Gemessen · {stations?.[i]?.name}</span>{" "}
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
            <div className="text-ink">
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
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 rounded" style={{ background: SERIES.wind }} /> Wind
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: SERIES.gust }} /> Böen
      </span>
      {(stations ?? []).map((st, i) => (
        <span key={st.id} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: stationColor(i) }} /> Gemessen ({st.name})
        </span>
      ))}
      {past && (
        <span
          className="flex items-center gap-1.5"
          title={`Konsens des Datenstands von ${fmtWeekdayTime(new Date(past.fetchedAt).getTime() / 1000)}, mit heutiger Korrektur gerechnet`}
        >
          <span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: SERIES.past }} />
          <span className="whitespace-nowrap">Prognose von vor 24&nbsp;h</span>
          {past.mae != null && past.n >= 3 && (
            <span className="text-faint">
              (lag Ø {convertWind(past.mae, unit)}&nbsp;{unitLabel(unit)} daneben
              {past.bias != null && Math.abs(past.bias) >= 1 ? `, meist zu ${past.bias > 0 ? "hoch" : "niedrig"}` : ""})
            </span>
          )}
        </span>
      )}
      {hasNowcast && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t-2 border-dotted" style={{ borderColor: SERIES.wind }} /> korrigiert nach Messung
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-4 rounded-sm" style={{ background: PALETTE.green, opacity: 0.3 }} />
        Fahrfenster
      </span>
    </div>
  );
}
