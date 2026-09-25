"use client";
import type { DaySummary } from "@/lib/kite";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { fmtDayMonth, fmtWeekday, noonOf } from "@/lib/dates";
import { WindTile, fmtWind, hourOf } from "./ui";

// Nur Änderungen zeigen — „stabil" ist der Normalfall.
const TREND_SYM = { steigt: "↗", fällt: "↘" } as const;

/**
 * Tagesleiste: je Tag eine schmale Spalte — Wochentag, Datum, Tages-Wind als Kachel (Ø der
 * 3 stärksten Tageslicht-Stunden, dieselben Farben wie das Raster) und, falls es eins gibt, das
 * beste Fahrfenster. Früher große Karten, die meist „kein Fahrfenster" sagten und von denen am
 * Handy zwei nebeneinander passten. Tage, für die nur noch globale Modelle rechnen, treten
 * zurück; die Einzelheiten (Böen, Modell-Spitze, Trend) stehen im Tag-Reiter.
 */
export default function DailyStrip({
  days,
  unit,
  onSelect,
  activeDay,
}: {
  days: DaySummary[];
  unit: WindUnit;
  onSelect?: (day: string) => void;
  activeDay?: string | null;
}) {
  if (!days.length) return null;
  const shown = days.slice(0, 16);
  const u = unitLabel(unit);
  return (
    <div className="border-y border-border-soft bg-[color:var(--color-bg-2)]/40 px-4 py-3 sm:px-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="label">Tage</span>
        <span className="text-[11px] text-faint">Tages-Wind (Ø stärkste 3 h) · Tippen öffnet den Tag</span>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {shown.map((d) => {
          const sec = noonOf(d.day);
          const wd = new Date(sec * 1000).getUTCDay();
          const we = wd === 0 || wd === 6;
          const active = activeDay === d.day;
          const tr = d.trend && d.trend.state !== "stabil" ? d.trend : null;
          const title = [
            `${d.label}: ${fmtWind(d.peak, unit)} ${u}, Böen ${fmtWind(d.gust, unit)} ${u}`,
            d.best ? `bestes Fenster ${hourOf(d.best.start)}–${hourOf(d.best.end)} Uhr` : "kein Fahrfenster",
            tr ? `Tages-Wind ${tr.state} ${tr.since}` : null,
            d.globalOnly ? "nur globale Modelle — unsicher" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={d.day}
              type="button"
              onClick={() => onSelect?.(d.day)}
              className="flex w-[54px] shrink-0 flex-col items-center gap-1 rounded-lg border px-1 pb-1.5 pt-1 text-center transition-colors hover:border-accent sm:w-auto sm:min-w-[54px] sm:flex-1"
              style={{
                background: active ? "var(--tint-accent)" : we ? "var(--tint-neutral)" : "transparent",
                borderColor: active ? "var(--color-accent)" : "var(--color-border-soft)",
                cursor: onSelect ? "pointer" : "default",
                opacity: d.globalOnly ? 0.55 : 1,
              }}
              title={title}
            >
              <span className="whitespace-nowrap text-[11px] leading-tight text-ink" style={{ fontWeight: we ? 700 : 600 }}>
                {fmtWeekday(sec)}
                {tr && <span className="ml-0.5 font-500">{TREND_SYM[tr.state as "steigt" | "fällt"]}</span>}
              </span>
              <span className="text-[10px] leading-tight text-muted">{fmtDayMonth(sec)}</span>
              <WindTile kt={d.peak} unit={unit} className="w-[34px] font-mono text-[12px] leading-[20px]" />
              <span className="h-[15px] whitespace-nowrap text-[10px] leading-[15px]">
                {d.best && (
                  <span
                    className="rounded-full px-1 text-ink"
                    style={{ background: "var(--tint-good)", boxShadow: "inset 0 0 0 1px var(--tint-good-line)" }}
                  >
                    {hourOf(d.best.start)}–{hourOf(d.best.end)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
