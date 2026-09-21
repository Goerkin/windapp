"use client";
import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotPayload } from "@/lib/types";
import { convertWind, unitLabel, compass, topKMean, type WindUnit } from "@/lib/units";
import { PALETTE, ktColorHex } from "@/lib/palette";
import { DIR_LABEL, MIN_WINDOW_H, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { WindArrow, DeltaBadge, WindowLine, TrendMark, fmtTime, hourOf, windBands } from "./ui";

const TZ = "Europe/Amsterdam";

export default function DayDetail({
  spot,
  unit,
  th,
  hours,
  days,
  selectedDay,
  onSelectDay,
}: {
  spot: SpotPayload;
  unit: WindUnit;
  th: Thresholds;
  hours: HourEval[];
  days: DaySummary[];
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
}) {
  const day = selectedDay ?? days[0]?.day ?? null;
  const summary = days.find((d) => d.day === day) ?? null;

  // Stunden des Tages im Tageslicht (fahrbare Zeit) — mit Bewertung je Stunde.
  const dayHours = useMemo(() => hours.filter((h) => h.day === day && h.daylight), [hours, day]);
  const dayIdx = useMemo(() => dayHours.map((h) => ({ t: h.t, i: h.i })), [dayHours]);
  const evalAt = useMemo(() => new Map(dayHours.map((h) => [h.t, h])), [dayHours]);

  const chart = useMemo(() => {
    const conv = (v: number | null) => convertWind(v, unit);
    return dayIdx.map(({ t, i }) => {
      const p = spot.points[i];
      return {
        t,
        wind: conv(p?.windspd ?? null),
        gust: conv(p?.gust ?? null),
        dir: p?.winddir ?? null,
        windKt: p?.windspd ?? null,
        prob: evalAt.get(t)?.pMin ?? null,
      };
    });
  }, [dayIdx, spot.points, unit, evalAt]);

  // Tabelle: 2-h-Raster über die Tageslicht-Stunden.
  const rows = useMemo(
    () =>
      dayIdx
        .filter(({ t }) => hourOf(t) % 2 === 0)
        .map(({ t, i }) => ({ t, p: spot.points[i], ev: evalAt.get(t) })),
    [dayIdx, spot.points, evalAt],
  );

  // Kennwerte des Tages.
  const stats = useMemo(() => {
    const winds = dayIdx.map(({ i }) => spot.points[i]?.windspd).filter((v): v is number => v != null);
    if (!winds.length) return null;
    // Aussagekräftiger Tages-Wind: Ø der 3 stärksten Stunden (statt einer kurzen Spitze).
    const sustained = topKMean(winds, 3);
    const gustSustained = topKMean(dayIdx.map(({ i }) => spot.points[i]?.gust), 3);
    const peakEntry = dayIdx.reduce<{ v: number; t: number; g: number | null; d: number | null } | null>(
      (acc, { i }) => {
        const p = spot.points[i];
        if (p?.windspd == null) return acc;
        if (!acc || p.windspd > acc.v) return { v: p.windspd, t: p.t, g: p.gust, d: p.winddir };
        return acc;
      },
      null,
    );
    return { min: Math.min(...winds), max: Math.max(...winds), sustained, gustSustained, peak: peakEntry };
  }, [dayIdx, spot.points]);

  // Entwicklung dieses Tages über die letzten Datenstände (Peak je Lauf + jetzt).
  const evo = useMemo(() => {
    const now = Date.now() / 1000;
    // Ø der 3 stärksten Stunden des Tages (konsistent mit den Tages-Kennwerten).
    const peakOf = (arr: (number | null)[]) => topKMean(dayIdx.map(({ i }) => arr[i]), 3);
    const curPeak = peakOf(spot.points.map((p) => p.windspd));
    const pts = spot.trend.runs
      .map((r) => ({ ageH: (now - new Date(r.fetchedAt).getTime() / 1000) / 3600, peak: peakOf(r.wind) }))
      .filter((x) => x.peak != null)
      .sort((a, b) => b.ageH - a.ageH); // alt → neu
    pts.push({ ageH: 0, peak: curPeak });
    return { pts, curPeak };
  }, [dayIdx, spot.points, spot.trend.runs]);

  if (!day || !dayIdx.length) {
    return <p className="text-sm text-muted">Keine Daten für diesen Tag.</p>;
  }

  const curDaily = spot.trend.daily.find((d) => d.day === day);
  const conv = (v: number | null) => (v == null ? "–" : unit === "ms" ? convertWind(v, unit)!.toFixed(1) : String(Math.round(convertWind(v, unit)!)));

  return (
    <div>
      {/* Tages-Navigation */}
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {days.slice(0, 16).map((d) => (
          <button
            key={d.day}
            onClick={() => onSelectDay(d.day)}
            className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-600 transition-colors"
            style={{
              borderColor: d.day === day ? ktColorHex(d.peak) : d.best ? "rgba(34,197,94,.45)" : "var(--color-border)",
              background: d.day === day ? "rgba(255,255,255,.04)" : "transparent",
              color: d.day === day ? "var(--color-ink)" : "var(--color-muted)",
              opacity: d.globalOnly ? 0.6 : 1,
            }}
          >
            {d.label}
            {d.best && <span className="ml-1 text-[color:var(--wg-green)]">●</span>}
          </button>
        ))}
      </div>

      {/* Fahrfenster des Tages */}
      {summary && (
        <div className="mb-3 rounded-xl border border-border-soft px-3 py-2">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-muted">
            <span>Fahrfenster (≥ {MIN_WINDOW_H} h am Stück, Tageslicht, Richtung ok, ≥ 50 % für {conv(th.min)} {unitLabel(unit)})</span>
            <TrendMark trend={summary.trend} unit={unit} />
          </div>
          {summary.windows.length ? (
            <ul className="space-y-1 text-sm">
              {summary.windows.map((w) => (
                <li key={w.start}>
                  <WindowLine w={w} unit={unit} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Kein fahrbares Fenster an diesem Tag.</p>
          )}
          {summary.globalOnly && (
            <p className="mt-1 text-[11px] text-faint">
              Nur noch globale Modelle (IFS/GFS/ICON) — die hochauflösenden Küstenmodelle reichen nicht so weit. Vorhersage unsicher.
            </p>
          )}
        </div>
      )}

      {/* Kennwerte */}
      {stats && (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Stat label="stärkste 3 h" big>
            <span style={{ color: ktColorHex(stats.sustained) }}>{conv(stats.sustained)}</span>
            <span className="ml-1 text-xs text-muted">{unitLabel(unit)}</span>
          </Stat>
          <Stat label="Böen (Ø 3 h)">{conv(stats.gustSustained)} {unitLabel(unit)}</Stat>
          <Stat label="kurze Spitze">
            {conv(stats.peak?.v ?? null)} {unitLabel(unit)}
            {stats.peak && <span className="ml-1 text-xs text-muted">um {fmtTime(stats.peak.t)}</span>}
          </Stat>
          {summary?.modelPeak != null && (
            <Stat label="Modell-Spitze">
              <span title="Gewichteter Median der Tages-Spitzen der einzelnen Modelle — unabhängig davon, zu welcher Stunde jedes Modell sie sieht">
                {conv(summary.modelPeak)} {unitLabel(unit)}
              </span>
            </Stat>
          )}
          <Stat label="Spanne">
            {conv(stats.min)}–{conv(stats.max)} {unitLabel(unit)}
          </Stat>
          <Stat label="Richtung">
            <span className="inline-flex items-center gap-1">
              <WindArrow dir={stats.peak?.d ?? null} kt={stats.peak?.v ?? null} size={16} />
              {compass(stats.peak?.d ?? null)}
            </span>
          </Stat>
          {curDaily && (
            <div className="flex flex-wrap items-center gap-1.5">
              {curDaily.deltas.map((dl) => (
                <DeltaBadge key={dl.key} delta={dl.delta} unit={unit} label={dl.label} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Stundenverlauf — Tageslicht */}
      <div className="mb-1 text-[11px] text-faint">Stundenverlauf · Tageslicht (grün = Fahrfenster)</div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chart} margin={{ top: 22, right: 6, bottom: 4, left: -18 }}>
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
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 12, fill: PALETTE.axis }}
            stroke={PALETTE.axisLine}
            tickLine={{ stroke: PALETTE.axisLine }}
            width={40}
          />
          {summary?.windows.map((w) => (
            <ReferenceArea key={w.start} x1={w.start} x2={w.end - 3600} fill={PALETTE.green} fillOpacity={0.12} stroke="none" ifOverflow="hidden" />
          ))}
          <ReferenceLine y={convertWind(th.min, unit) ?? undefined} stroke={PALETTE.green} strokeOpacity={0.45} strokeDasharray="6 4" />
          <Line type="monotone" dataKey="gust" stroke={PALETTE.gust} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="wind" stroke={PALETTE.teal} strokeWidth={2.4} isAnimationActive={false} dot={<DirDot />} activeDot={{ r: 4 }} />
          <Tooltip content={<DayTooltip unit={unit} />} />
        </ComposedChart>
      </ResponsiveContainer>

      {/* 3-h-Tabelle */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="py-1.5 pr-3 font-600">Zeit</th>
              <th className="py-1.5 pr-3 font-600">Wind</th>
              <th className="py-1.5 pr-3 font-600">Böen</th>
              <th className="py-1.5 pr-3 font-600">Richtung</th>
              <th className="py-1.5 pr-3 font-600" title={`Wahrscheinlichkeit für ≥ ${th.min} kn`}>P ≥ {conv(th.min)}</th>
              <th className="py-1.5 pr-3 font-600">Temp</th>
              <th className="py-1.5 pr-3 font-600">Wolken</th>
              <th className="py-1.5 pr-3 font-600">Regen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, p, ev }) => (
              <tr
                key={t}
                className="border-t border-border-soft"
                style={{ background: ev?.rideable ? "rgba(34,197,94,.06)" : undefined }}
              >
                <td className="py-1.5 pr-3 font-mono text-body">{fmtTime(t)}</td>
                <td className="py-1.5 pr-3 font-mono font-600" style={{ color: ktColorHex(p?.windspd ?? null) }}>
                  {conv(p?.windspd ?? null)}
                </td>
                <td className="py-1.5 pr-3 font-mono text-body">{conv(p?.gust ?? null)}</td>
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1 text-body">
                    <WindArrow dir={p?.winddir ?? null} kt={p?.windspd ?? null} size={13} />
                    <span className="font-mono">{compass(p?.winddir ?? null)}</span>
                    {ev?.dirQ && ev.dirQ !== "good" && (
                      <span
                        title={DIR_LABEL[ev.dirQ]}
                        style={{ color: ev.dirQ === "bad" ? "var(--wg-red)" : "var(--wg-amber)" }}
                      >
                        {ev.dirQ === "bad" ? "✕" : "!"}
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-body">
                  {ev?.pMin != null ? `${Math.round(ev.pMin * 100)} %` : "–"}
                  {ev?.squall && <span className="ml-1" title="Schauerböen-Verdacht">⚡</span>}
                </td>
                <td className="py-1.5 pr-3 text-body">{p?.tmp != null ? `${Math.round(p.tmp)}°` : "–"}</td>
                <td className="py-1.5 pr-3 text-body">{p?.cloud != null ? `${p.cloud}%` : "–"}</td>
                <td className="py-1.5 pr-3 text-body">{p?.precip != null && p.precip > 0 ? `${p.precip} mm` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Entwicklung dieses Tages */}
      {evo.pts.length > 2 && (
        <div className="mt-5">
          <div className="mb-1 text-xs uppercase tracking-wider text-muted">
            Entwicklung des Tages-Winds über die letzten Datenstände
          </div>
          <p className="mb-2 text-[11px] text-faint">
            Wie sich der vorhergesagte Wind (Ø der 3 stärksten Stunden) für diesen Tag mit jedem
            neuen Lauf (3–6-h-Raster) verändert hat.
          </p>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={evo.pts} margin={{ top: 8, right: 10, bottom: 0, left: -22 }}>
              <CartesianGrid stroke={PALETTE.gridLine} strokeDasharray="2 4" vertical={false} />
              {windBands(unit)}
              <XAxis
                dataKey="ageH"
                type="number"
                domain={["dataMin", 0]}
                reversed
                tickFormatter={(h) => (h === 0 ? "jetzt" : `-${Math.round(h)}h`)}
                tick={{ fontSize: 11, fill: PALETTE.axis }}
                stroke={PALETTE.axisLine}
                tickLine={{ stroke: PALETTE.axisLine }}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: PALETTE.axis }}
                stroke={PALETTE.axisLine}
                tickLine={{ stroke: PALETTE.axisLine }}
                width={34}
              />
              <ReferenceLine x={0} stroke="#22d3ee" strokeOpacity={0.5} />
              <Line
                type="monotone"
                dataKey="peak"
                stroke={PALETTE.teal}
                strokeWidth={2}
                dot={{ r: 2.5, fill: PALETTE.teal }}
                isAnimationActive={false}
                connectNulls
              />
              <Tooltip content={<EvoTooltip unit={unit} />} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


function Stat({ label, children, big }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className={big ? "font-display text-2xl text-ink" : "text-base text-ink"}>{children}</div>
    </div>
  );
}

function DirDot(props: { cx?: number; cy?: number; index?: number; payload?: { dir: number | null; windKt: number | null } }) {
  const { cx, cy, index, payload } = props;
  if (cx == null || cy == null || payload?.dir == null || index == null || index % 3 !== 0) return <g />;
  return (
    <g transform={`translate(${cx}, ${cy - 15}) rotate(${payload.dir + 180})`}>
      <path d="M0 -4 L3 5 L0 3 L-3 5 Z" fill={ktColorHex(payload.windKt ?? null)} />
    </g>
  );
}

function DayTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: { t: number; wind: number | null; gust: number | null; dir: number | null } }>;
  unit?: WindUnit;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const u = unit ?? "kn";
  const fmt = (v: number | null) => (v == null ? "–" : u === "ms" ? v.toFixed(1) : String(Math.round(v)));
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="mb-1 font-600 text-ink">{fmtTime(p.t)} Uhr</div>
      <div className="text-body">
        Wind <span className="font-mono text-ink">{fmt(p.wind)}</span> · Böen{" "}
        <span className="font-mono text-ink">{fmt(p.gust)}</span> {unitLabel(u)}
      </div>
      <div className="text-muted">{compass(p.dir)} ({p.dir ?? "–"}°)</div>
    </div>
  );
}

function EvoTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: { ageH: number; peak: number | null } }>;
  unit?: WindUnit;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const u = unit ?? "kn";
  const v = convertWind(p.peak, u);
  return (
    <div className="rounded-lg border border-border bg-[color:var(--color-bg-2)] px-3 py-2 text-xs">
      <div className="font-600 text-ink">{p.ageH === 0 ? "jetziger Stand" : `Stand vor ${Math.round(p.ageH)} h`}</div>
      <div className="text-body">
        Wind (Ø 3 h) <span className="font-mono text-ink">{v == null ? "–" : u === "ms" ? v.toFixed(1) : Math.round(v)}</span> {unitLabel(u)}
      </div>
    </div>
  );
}
