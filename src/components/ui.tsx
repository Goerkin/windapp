"use client";
import { useSyncExternalStore } from "react";
import { compass, convertWind, unitLabel, type WindUnit } from "@/lib/units";
import { ReferenceArea } from "recharts";
import { ktColor, ktColorHex, PALETTE } from "@/lib/palette";
import { TH, TONE_LABEL, toneFloor, toneOf, type RideWindow, type Tone, type TrendState } from "@/lib/kite";
import { fmtDay } from "@/lib/dates";

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
  const color = kt != null ? ktColor(kt) : "var(--color-body)";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${dir + 180}deg)` }}>
      <path d="M12 2 L18 20 L12 16 L6 20 Z" style={{ fill: color }} />
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
      <span className="chip" style={{ color: "var(--color-muted)" }}>
        {pre}→
      </span>
    );
  }
  // Neutral: die Pfeilform trägt die Richtung. Rot heißt „gefährlich/ablandig", Grün „gut" —
  // eine schwächere Prognose ist weder das eine noch das andere.
  const up = delta > 0;
  const v = convertWind(Math.abs(delta), unit);
  const txt = v == null ? "" : unit === "ms" ? v.toFixed(1) : String(Math.round(v));
  return (
    <span
      className="chip"
      style={{
        color: "var(--color-ink)",
        borderColor: "color-mix(in srgb, var(--color-ink) 35%, transparent)",
        background: "var(--tint-neutral)",
      }}
      title={`Änderung des Tages-Winds (Ø stärkste 3 h) gegenüber dem Datenstand vor ~${label ?? "24 h"}`}
    >
      {pre}
      {up ? "▲" : "▼"} {txt} {unitLabel(unit)}
    </span>
  );
}

export function Compass({ dir }: { dir: number | null }) {
  return <span className="tabular-nums">{compass(dir)}</span>;
}

/**
 * Wahrscheinlichkeit als kleiner Füllbalken + Zahl. Bewusst NEUTRAL (Tinte, keine Windfarbe):
 * Orange/Gelb/Grün bedeuten in der Windskala „kräftig/zu viel/gut" — als Farbe für Prozente
 * hätten sie zwei Bedeutungen gleichzeitig.
 */
export function ProbMeter({ p, title }: { p: number; title?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <span className="relative inline-block h-1.5 w-7 overflow-hidden rounded-full bg-[color:var(--color-border)]">
        <span className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${pct}%`, opacity: 0.35 + 0.65 * (pct / 100) }} />
      </span>
      <span className="tabular-nums text-body">{pct} %</span>
    </span>
  );
}

/** Kleine Symbole im Stil der übrigen Linien-Icons (statt Emoji, die je Gerät anders aussehen). */
export function WaveIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="inline-block align-[-1px]">
      <path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 16c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" style={{ stroke: "var(--wg-teal)" }} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function SunIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="inline-block align-[-1px]">
      <circle cx="12" cy="12" r="4" style={{ stroke: "var(--color-muted)" }} strokeWidth="2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" style={{ stroke: "var(--color-muted)" }} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const _hourOnly = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });

/** „Sa 26.9. 11–17 Uhr · 18–22 kn · WSW · 80 %" — die Kernaussage eines Fahrfensters. */
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
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="font-600 text-ink">
        {withDay && `${fmtDay(w.start)} `}
        {h(w.start)}–{h(w.end)}
        {!compact && "\u00a0Uhr"}
      </span>
      <span className="text-faint">·</span>
      <span className="font-600 tabular-nums" style={{ color: ktColor((w.lo + w.hi) / 2) }}>
        {lo === hi ? lo : `${lo}–${hi}`}
      </span>
      <span className="text-muted">{unitLabel(unit)}</span>
      <span className="text-faint">·</span>
      <span className="inline-flex items-center gap-0.5">
        <WindArrow dir={w.dir} kt={(w.lo + w.hi) / 2} size={12} />
        <span className="text-body">{compass(w.dir)}</span>
        {w.dirQ === "ok" && <span title="Richtung nur bedingt geeignet" className="font-700 text-ink">!</span>}
      </span>
      <span className="text-faint">·</span>
      <ProbMeter
        p={w.prob}
        title="Durchschnitt der stündlichen Wahrscheinlichkeiten für den Mindestwind im Fenster. Dass es über das GANZE Fenster reicht, ist weniger wahrscheinlich."
      />
    </span>
  );
}

/** „stabil / steigt / fällt seit gestern" als kleine Markierung. */
export function TrendMark({ trend, unit, compact = false }: { trend: TrendState | null; unit: WindUnit; compact?: boolean }) {
  if (!trend) return null;
  // Neutral wie DeltaBadge — der Pfeil sagt „steigt/fällt", die Farbe bleibt der Windstärke.
  const color = trend.state === "stabil" ? "var(--color-muted)" : "var(--color-ink)";
  const sym = trend.state === "stabil" ? "→" : trend.state === "steigt" ? "↗" : "↘";
  const v = convertWind(Math.abs(trend.delta), unit);
  return (
    <span
      className="whitespace-nowrap text-[11px]"
      style={{ color }}
      title={`Tages-Wind ${trend.state} ${trend.since} (${trend.delta > 0 ? "+" : trend.delta < 0 ? "−" : "±"}${v ?? 0} ${unitLabel(unit)})`}
    >
      {sym} {trend.state}
      {!compact && ` ${trend.since}`}
    </span>
  );
}

/** Gemessene Wassertemperatur(en) — „≈ 17.8° Nordsee · 18.0° Grevelingen"; sonst Windguru-Schätzung. */
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
        <WaveIcon /> ~{fallback}°
      </span>
    ) : null;
  }
  return (
    <span className={className}>
      <WaveIcon />
      {"\u00a0"}
      {water.map((w, i) => (
        <span key={w.name} title={`gemessen ${relTime(w.obsTime)} · Rijkswaterstaat`}>
          {i > 0 && " · "}
          <span className="whitespace-nowrap">
            <span className="text-body">{w.value.toFixed(1)}°</span>
            {water.length > 1 && <span className="text-faint">{"\u00a0"}{w.name}</span>}
          </span>
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

// Richtung „ablandig/ungeeignet" im Raster: rot hinterlegt (Rot heißt genau das).
export const OFFSHORE_TINT = "color-mix(in srgb, var(--wg-red) 25%, transparent)";

/**
 * Wind-Kachel wie bei Windguru, aber mit klarer Rangfolge: unter 10 kn keine Fläche (leise),
 * 10–13 kn zart getönt, ab 13 kn volle Farbe. Früher war „zu wenig" ein voller grauer Block —
 * die dunkelste Fläche der Seite —, und die paar fahrbaren Stunden gingen darin unter.
 * `text` ersetzt die Zahl (Legende).
 */
export function WindTile({
  kt,
  unit,
  text,
  className = "",
}: {
  kt: number | null;
  unit: WindUnit;
  text?: string;
  className?: string;
}) {
  if (kt == null) return <span className={`block text-faint ${className}`}>–</span>;
  const tone = toneOf(kt, TH);
  const label = text ?? fmtWind(kt, unit);
  if (tone === "grey") return <span className={`block text-muted ${className}`}>{label}</span>;
  if (tone === "blue") {
    return (
      <span className={`block rounded-[3px] text-body ${className}`} style={{ background: "color-mix(in srgb, var(--wg-blue) 22%, transparent)" }}>
        {label}
      </span>
    );
  }
  return (
    <span
      className={`block rounded-[3px] font-600 ${className}`}
      // dunkle Schrift auf gesättigter Kachel, in beiden Themen
      style={{ background: ktColorHex(kt) + "d9", color: "#0b1220" }}
    >
      {label}
    </span>
  );
}

const TONES: Tone[] = ["grey", "blue", "teal", "green", "amber", "orange", "red"];

/** Legende zum Kachel-Raster: Farbstufen (Untergrenze in der gewählten Einheit) + Markierungen. */
export function WindScale({ unit }: { unit: WindUnit }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
      <span className="text-faint">Wind in {unitLabel(unit)}:</span>
      {TONES.map((tone) => {
        const floor = toneFloor(tone, TH);
        const sample = tone === "grey" ? TH.min - 4 : floor;
        const text = tone === "grey" ? `<${fmtWind(TH.min - 3, unit)}` : fmtWind(floor, unit);
        return (
          <span key={tone} className="inline-flex items-center gap-1 whitespace-nowrap">
            <WindTile kt={sample} unit={unit} text={text} className="min-w-[24px] px-0.5 text-center font-mono text-[10px] leading-[16px]" />
            {TONE_LABEL[tone]}
          </span>
        );
      })}
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <span className="inline-block h-[3px] w-[14px] rounded-full bg-[color:var(--wg-green)]" /> fahrbare Stunde
      </span>
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <span className="hatch inline-block h-[12px] w-[14px] rounded-[2px]" /> Richtung bedingt
      </span>
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <span className="inline-block h-[12px] w-[14px] rounded-[2px]" style={{ background: OFFSHORE_TINT }} /> ablandig
      </span>
    </div>
  );
}

const WIDE = "(min-width: 640px)";
const subscribeWide = (cb: () => void) => {
  const m = matchMedia(WIDE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Breiter Bildschirm (ab sm)? Für Dichte-Entscheidungen in Diagrammen; der Server rechnet schmal. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches, () => false);
}
