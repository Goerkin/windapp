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
import { fmtTime, dayKeyOf, hourOf, windBands } from "./ui";
import HourBreakdown from "./HourBreakdown";

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

/**
 * Welche Modellwerte die Linien zeigen. Standard ist „korrigiert": nur so liegt der
 * Konsens auch dort, wo die Modelllinien liegen — er IST ihr gewichtetes Mittel. Mit den
 * Rohwerten sieht er systematisch daneben aus (an der Brouwersdam ~2 kn tiefer).
 */
type View = "adj" | "raw" | "both";
const VIEW_LABEL: Record<View, string> = { adj: "korrigiert", raw: "roh", both: "beide" };

/** Modellwert an Stunde i — korrigiert, wenn vorhanden und gewünscht. */
function pick(m: { wind: (number | null)[]; windAdj?: (number | null)[] }, i: number, view: View) {
  return view === "raw" ? m.wind[i] : m.windAdj?.[i] ?? m.wind[i];
}

const reachFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" });

export default function ModelPanel({ spot, unit }: { spot: SpotPayload; unit: WindUnit }) {
  const [count, setCount] = useState(6);
  const [view, setView] = useState<View>("adj");
  // Tages-Fokus: null = die nächsten 3 Tage am Stück; sonst genau dieser Tag.
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const days = spot.trend.daily.slice(0, 16);
  // Isolierte Modelle: leere Auswahl = alle zeigen; sonst nur die gewählten (+ Konsens).
  // In einem Set gehalten; per Klick auf die Legende umgeschaltet.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Aufgeschlüsselte Stunde (Index im Konsens-Raster); null = automatisch.
  const [hourPick, setHourPick] = useState<number | null>(null);

  // Gezeigter Zeitraum als Raster-Indizes.
  const idx = useMemo(() => {
    const end = Date.now() / 1000 + 72 * 3600;
    return spot.gridTimes
      .map((t, i) => ({ t, i }))
      .filter((x) => (dayFilter ? dayKeyOf(x.t) === dayFilter : x.t <= end));
  }, [spot.gridTimes, dayFilter]);

  // Anteil jedes Modells am Konsens IM GEZEIGTEN ZEITRAUM (Summe seiner Stundengewichte).
  // Danach wird sortiert: ein Kurzfrist-Modell ist für morgen wichtig, auch wenn es über
  // 16 Tage gerechnet kaum vorkommt.
  const ranked = useMemo(() => {
    const sums = spot.models.map((m) => idx.reduce((a, { i }) => a + (m.wh?.[i] ?? 0), 0));
    const total = sums.reduce((a, b) => a + b, 0) || 1;
    return spot.models
      .map((m, k) => ({ m, share: sums[k] / total }))
      .sort((a, b) => b.share - a.share || b.m.weight - a.m.weight);
  }, [spot.models, idx]);
  const topModels = ranked.slice(0, count).map((r) => r.m);

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
    const data = idx.map(({ t, i }) => {
      const row: Record<string, number | null> = { t };
      const cp = spot.points[i];
      row.consensus = convertWind(cp?.windspd ?? null, unit);
      topModels.forEach((m) => {
        row[`m${m.idModel}`] = convertWind(pick(m, i, view) ?? null, unit);
        if (view === "both") row[`m${m.idModel}_raw`] = convertWind(m.wind[i] ?? null, unit);
      });
      // Konsens OHNE Nachkorrektur — bewusst mit denselben Stundengewichten wie der echte
      // Konsens, damit der Abstand allein die Korrektur zeigt und nicht die Gewichtung.
      if (view !== "adj") {
        let num = 0;
        let den = 0;
        for (const m of spot.models) {
          const w = m.wh?.[i];
          const raw = m.wind[i];
          if (w == null || raw == null) continue;
          num += w * raw;
          den += w;
        }
        row.consensusRaw = den > 0 ? convertWind(num / den, unit) : null;
      }
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
  }, [idx, spot.points, spot.models, topModels, unit, view]);

  const nowSec = Date.now() / 1000;
  // Ohne Auswahl: die erste Stunde ab jetzt im Zeitraum, beim Einzeltag 14 Uhr.
  const autoHour =
    (dayFilter
      ? idx.find(({ t }) => hourOf(t) === 14)
      : idx.find(({ t }) => t >= nowSec - 3600)) ?? idx[0];
  const hourIdx = hourPick ?? autoHour?.i ?? null;
  const pickDay = (d: string | null) => {
    setDayFilter(d);
    setHourPick(null);
  };

  return (
    <div>
      {/* Tages-Navigation: „3 Tage" am Stück oder ein einzelner Tag im Fokus. */}
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        <DayBtn active={dayFilter === null} onClick={() => pickDay(null)}>
          3 Tage
        </DayBtn>
        {days.map((d) => (
          <DayBtn key={d.day} active={dayFilter === d.day} onClick={() => pickDay(d.day)}>
            {d.label}
          </DayBtn>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          Alle Modelle vs. Konsens · Wind ({unitLabel(unit)}) ·{" "}
          {dayFilter ? days.find((d) => d.day === dayFilter)?.label ?? "Tag" : "nächste 3 Tage"}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" role="group" aria-label="Modellwerte">
            {(["adj", "raw", "both"] as View[]).map((v) => (
              <button
                key={v}
                data-active={view === v}
                onClick={() => setView(v)}
                title={
                  v === "adj"
                    ? "Nachkorrigiert — so geht der Wert in den Konsens ein"
                    : v === "raw"
                      ? "Rohwerte, wie Windguru sie liefert"
                      : "Beides: korrigiert durchgezogen, roh gestrichelt"
                }
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          <div className="seg">
            {[4, 6, 10].map((c) => (
              <button key={c} data-active={count === c} onClick={() => setCount(c)}>
                Top {c}
              </button>
            ))}
            <button data-active={count >= spot.models.length} onClick={() => setCount(spot.models.length)}>
              Alle
            </button>
          </div>
        </div>
      </div>

      <p className="mb-2 text-[11px] text-faint">
        {view === "adj"
          ? "Modellwerte nach der gelernten Nachkorrektur — der Konsens ist ihr gewichtetes Mittel."
          : view === "raw"
            ? "Rohe Modellwerte von Windguru. Die gestrichelte Linie ist der Mix daraus, die durchgezogene der korrigierte Konsens — ihr Abstand ist das, was die Nachkorrektur beiträgt."
            : "Durchgezogen korrigiert, gestrichelt roh. Der Abstand ist der gelernte Fehler des jeweiligen Modells."}
      </p>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart
          data={data}
          margin={{ top: 22, right: 6, bottom: 4, left: -18 }}
          onClick={(st) => {
            const k = Number(st?.activeTooltipIndex);
            if (Number.isInteger(k) && idx[k]) setHourPick(idx[k].i);
          }}
          style={{ cursor: "pointer" }}
        >
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
          {hourIdx != null && spot.gridTimes[hourIdx] != null && (
            <ReferenceLine x={spot.gridTimes[hourIdx]} className="ref-chrome" stroke={PALETTE.axis} strokeOpacity={0.7} strokeDasharray="2 2" />
          )}
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
          {/* „beide": dieselbe Farbe gestrichelt und dünner — der Abstand ist die Korrektur. */}
          {view === "both" &&
            topModels.map((m, i) =>
              isShown(m.idModel) ? (
                <Line
                  key={`${m.idModel}-raw`}
                  type="monotone"
                  dataKey={`m${m.idModel}_raw`}
                  stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                  opacity={0.6}
                />
              ) : null,
            )}
          {view !== "adj" && (
            <Line
              type="monotone"
              dataKey="consensusRaw"
              className="line-consensus"
              stroke={PALETTE.axis}
              strokeWidth={1.6}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
              connectNulls
              opacity={0.55}
            />
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
          <Tooltip content={<ModelTooltip models={shownModels} unit={unit} view={view} />} />
        </LineChart>
      </ResponsiveContainer>

      {/* Legende — Modelle anklickbar: nur das/die Gewählte(n) zeigen. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-body">
          <span className="inline-block h-0.5 w-5 rounded bg-ink" /> Konsens
        </span>
        {view !== "adj" && (
          <span className="flex items-center gap-1.5 text-muted" title="Derselbe Mix ohne die gelernte Nachkorrektur">
            <span
              className="inline-block h-0 w-5 border-t border-dashed border-ink opacity-60"
              aria-hidden
            />{" "}
            Konsens ohne Korrektur
          </span>
        )}
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

      {/* Aufschlüsselung einer Stunde: woraus der Konsens besteht */}
      {hourIdx != null && (
        <div className="mt-5 rounded-xl border border-border p-3">
          <HourBreakdown
            spot={spot}
            index={hourIdx}
            unit={unit}
            onStep={(d) => setHourPick(Math.max(0, Math.min(spot.gridTimes.length - 1, hourIdx + d)))}
          />
        </div>
      )}

      {/* Modell-Erklärungen + Anteile im gezeigten Zeitraum */}
      <div className="mt-5">
        <div className="mb-1 text-xs uppercase tracking-wider text-muted">
          Modelle im gezeigten Zeitraum
        </div>
        <p className="mb-2 text-[11px] text-faint">
          Anteil = wie stark das Modell in die Stunden dieses Zeitraums eingeht. Kurzfrist-Modelle
          reichen nur 1–3 Tage weit; danach tragen allein die globalen Modelle den Konsens.
        </p>
        <div className="space-y-2">
          {ranked.slice(0, count).map(({ m, share }) => (
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
                  <span className="text-muted" title="Anteil am Konsens in den Stunden des gezeigten Zeitraums">
                    {share > 0 ? `${(share * 100).toFixed(0)} %` : "nicht im Zeitraum"}
                  </span>
                </div>
              </div>
              {/* Anteils-Balken (voll = ein Drittel des Zeitraums) */}
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-bg-2)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, share * 100 * 3)}%`, background: CAT_COLOR[m.category] }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {m.note}
                {m.coverEnd != null && (
                  <span className="text-faint"> · reicht bis {reachFmt.format(new Date(m.coverEnd * 1000))}</span>
                )}
              </p>
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
  view,
}: {
  active?: boolean;
  payload?: Array<{ payload: Record<string, number | null> }>;
  models: { idModel: number; label: string }[];
  unit: WindUnit;
  view: View;
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
        {view !== "adj" && row.consensusRaw != null && (
          <span className="text-muted"> · ohne Korrektur {fmt(row.consensusRaw)}</span>
        )}
      </div>
      {models.map((m) => (
        <div key={m.idModel} className="text-muted">
          {m.label}: <span className="font-mono">{fmt(row[`m${m.idModel}`])}</span>
          {view === "both" && row[`m${m.idModel}_raw`] != null && (
            <span className="text-faint"> (roh {fmt(row[`m${m.idModel}_raw`])})</span>
          )}
        </div>
      ))}
    </div>
  );
}
