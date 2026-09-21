"use client";
import { compass, convertWind, unitLabel, type WindUnit } from "@/lib/units";
import { ReferenceArea } from "recharts";
import { ktColorHex, PALETTE } from "@/lib/palette";
import { TH, type RideWindow, type TrendState } from "@/lib/kite";

const TZ = "Europe/Amsterdam";

export function fmtWind(kt: number | null, unit: WindUnit): string {
  const v = convertWind(kt, unit);
  return v == null ? "–" : v.toFixed(unit === "ms" ? 1 : 0);
}

export function fmtTime(sec: number): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(
    new Date(sec * 1000),
  );
}

const _dayKeyFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ });
export function dayKeyOf(sec: number): string {
  return _dayKeyFmt.format(new Date(sec * 1000));
}
const _hourFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
export function hourOf(sec: number): number {
  return parseInt(_hourFmt.format(new Date(sec * 1000)), 10);
}
export function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
export function relTime(iso: string): string {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "gerade eben";
  if (diffMin < 60) return `vor ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `vor ${h} h`;
  return `vor ${Math.floor(h / 24)} d`;
}

/** Windpfeil — zeigt, wohin der Wind weht (WINDDIR = Herkunft, also +180°). */
export function WindArrow({
  dir,
  kt,
  size = 26,
}: {
  dir: number | null;
  kt?: number | null;
  size?: number;
}) {
  if (dir == null) return <span className="text-muted">–</span>;
  const color = kt != null ? ktColorHex(kt) : "#c3cbdc";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${dir + 180}deg)` }}>
      <path d="M12 2 L18 20 L12 16 L6 20 Z" fill={color} />
    </svg>
  );
}

export function DeltaBadge({
  delta,
  unit,
  label,
}: {
  delta: number | null;
  unit: WindUnit;
  label?: string;
}) {
  const pre = label ? <span style={{ opacity: 0.6, marginRight: 3 }}>{label}</span> : null;
  if (delta == null || Math.abs(delta) < 0.5) {
    return (
      <span className="chip" style={{ color: "#8a93a8" }}>
        {pre}→
      </span>
    );
  }
  const up = delta > 0;
  const v = convertWind(Math.abs(delta), unit);
  const txt = v == null ? "" : unit === "ms" ? v.toFixed(1) : String(Math.round(v));
  return (
    <span
      className="chip"
      style={{
        color: up ? "#34d399" : "#fb7185",
        borderColor: up ? "rgba(52,211,153,.35)" : "rgba(251,113,133,.35)",
        background: up ? "rgba(52,211,153,.08)" : "rgba(251,113,133,.08)",
      }}
      title={`Änderung des Tages-Winds (Ø stärkste 3 h) gegenüber dem Datenstand vor ~${label ?? "24 h"}`}
    >
      {pre}
      {up ? "▲" : "▼"} {txt} {unitLabel(unit)}
    </span>
  );
}

export function Compass({ dir }: { dir: number | null }) {
  return <span className="font-mono">{compass(dir)}</span>;
}

const _hourOnly = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
const _dow = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "numeric", month: "numeric" });

/** „Sa 11–17 Uhr · 18–22 kn · WSW · 80 %" — die Kernaussage eines Fahrfensters. */
export function WindowLine({
  w,
  unit,
  withDay = false,
  compact = false,
}: {
  w: RideWindow;
  unit: WindUnit;
  withDay?: boolean;
  compact?: boolean;
}) {
  const h = (s: number) => String(parseInt(_hourOnly.format(new Date(s * 1000)), 10));
  const lo = fmtWind(w.lo, unit);
  const hi = fmtWind(w.hi, unit);
  const pct = Math.round(w.prob * 100);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="font-600 text-ink">
        {withDay && `${_dow.format(new Date(w.start * 1000)).replace(",", "")} `}
        {h(w.start)}–{h(w.end)}
        {!compact && " Uhr"}
      </span>
      <span className="text-faint">·</span>
      <span className="font-mono" style={{ color: ktColorHex((w.lo + w.hi) / 2) }}>
        {lo === hi ? lo : `${lo}–${hi}`}
      </span>
      <span className="text-muted">{unitLabel(unit)}</span>
      <span className="text-faint">·</span>
      <span className="inline-flex items-center gap-0.5">
        <WindArrow dir={w.dir} kt={(w.lo + w.hi) / 2} size={12} />
        <span className="font-mono text-body">{compass(w.dir)}</span>
        {w.dirQ === "ok" && <span title="Richtung nur bedingt geeignet" className="text-[color:var(--wg-amber)]">!</span>}
      </span>
      <span className="text-faint">·</span>
      <span
        className="font-600"
        style={{ color: pct >= 75 ? "#34d399" : pct >= 55 ? "#fbbf24" : "#fb923c" }}
        title="Durchschnitt der stündlichen Wahrscheinlichkeiten für den Mindestwind im Fenster. Dass es über das GANZE Fenster reicht, ist weniger wahrscheinlich."
      >
        Ø {pct} %
      </span>
    </span>
  );
}

/** „stabil / steigt / fällt seit gestern" als kleine Markierung. */
export function TrendMark({ trend, unit, compact = false }: { trend: TrendState | null; unit: WindUnit; compact?: boolean }) {
  if (!trend) return null;
  const color = trend.state === "stabil" ? "#8a93a8" : trend.state === "steigt" ? "#34d399" : "#fb7185";
  const sym = trend.state === "stabil" ? "→" : trend.state === "steigt" ? "↗" : "↘";
  const v = convertWind(Math.abs(trend.delta), unit);
  return (
    <span
      className="text-[11px]"
      style={{ color }}
      title={`Tages-Wind ${trend.state} ${trend.since} (${trend.delta > 0 ? "+" : trend.delta < 0 ? "−" : "±"}${v ?? 0} ${unitLabel(unit)})`}
    >
      {sym} {trend.state}
      {!compact && ` ${trend.since}`}
    </span>
  );
}

/** Gemessene Wassertemperatur(en) — „🌊 17.8° Nordsee · 18.0° Grevelingen"; sonst Windguru-Schätzung. */
export function WaterTemps({
  water,
  fallback,
  className = "",
}: {
  water: { name: string; value: number; obsTime: string }[];
  fallback?: number | null;
  className?: string;
}) {
  if (!water.length) {
    return fallback != null ? (
      <span className={className} title="Schätzung von Windguru (keine aktuelle Messung)">
        🌊 ~{fallback}°
      </span>
    ) : null;
  }
  return (
    <span className={className}>
      🌊{" "}
      {water.map((w, i) => (
        <span key={w.name} title={`gemessen ${relTime(w.obsTime)} · Rijkswaterstaat`}>
          {i > 0 && " · "}
          <span className="text-body">{w.value.toFixed(1)}°</span>
          {water.length > 1 && <span className="text-faint"> {w.name}</span>}
        </span>
      ))}
    </span>
  );
}

/**
 * Dezente waagerechte Farbbänder hinter Wind-Diagrammen — dieselben Schwellen und Farben wie
 * die Kacheln (knapp / fahrbar / gut / kräftig / zu viel). „zu wenig" bleibt neutral.
 * Als Array direkt in ein Recharts-Diagramm setzen (vor die Linien).
 */
export function windBands(unit: WindUnit) {
  const c = (kn: number) => convertWind(kn, unit) ?? kn;
  const bands: [number, number, string, number][] = [
    [TH.min - 3, TH.min, PALETTE.blue, 0.06],
    [TH.min, TH.good, PALETTE.teal, 0.06],
    [TH.good, TH.strong, PALETTE.green, 0.075],
    [TH.strong, TH.over, PALETTE.amber, 0.06],
    [TH.over, TH.over + 8, PALETTE.orange, 0.06],
    [TH.over + 8, 250, PALETTE.red, 0.06],
  ];
  return bands.map(([from, to, color, op]) => (
    <ReferenceArea key={`wb${from}`} y1={c(from)} y2={c(to)} fill={color} fillOpacity={op} stroke="none" ifOverflow="hidden" />
  ));
}
