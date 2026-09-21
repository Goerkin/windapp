"use client";
import type { DaySummary } from "@/lib/kite";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { ktColorHex } from "@/lib/palette";
import { WindArrow, WindowLine, TrendMark, fmtWind } from "./ui";

/**
 * Tageskarten: Hauptaussage ist das beste fahrbare Fenster des Tages. Darunter der
 * Tages-Wind (Ø stärkste 3 Tageslicht-Stunden), die Modell-Spitze und der Trend seit gestern.
 * Tage, für die nur noch globale Modelle rechnen, treten optisch zurück.
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
  return (
    <div className="border-y border-border-soft bg-[color:var(--color-bg-2)]/40 px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Tage · bestes Fahrfenster</span>
        <span className="text-[11px] text-faint">tippen für Details</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {shown.map((d) => {
          const color = ktColorHex(d.peak);
          const active = activeDay === d.day;
          const extra = d.windows.length - 1;
          return (
            <button
              key={d.day}
              type="button"
              onClick={() => onSelect?.(d.day)}
              className="min-w-[168px] flex-1 rounded-xl border p-2.5 text-left transition-colors hover:border-accent"
              style={{
                background: active ? "rgba(34,211,238,.06)" : d.best ? "rgba(34,197,94,.05)" : "rgba(255,255,255,.015)",
                borderColor: active ? "var(--color-accent)" : d.best ? "rgba(34,197,94,.35)" : "var(--color-border)",
                cursor: onSelect ? "pointer" : "default",
                opacity: d.globalOnly ? 0.6 : 1,
              }}
              title={d.globalOnly ? "Nur noch globale Modelle (IFS/GFS/ICON) — Vorhersage unsicher" : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-600 text-body">{d.label}</span>
                <TrendMark trend={d.trend} unit={unit} />
              </div>

              <div className="mt-1 min-h-[2.5rem] text-[12px] leading-snug">
                {d.best ? (
                  <>
                    <WindowLine w={d.best} unit={unit} compact />
                    {extra > 0 && <span className="ml-1 text-[10px] text-faint">+{extra} weiteres</span>}
                  </>
                ) : (
                  <span className="text-muted">kein Fahrfenster</span>
                )}
              </div>

              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                <WindArrow dir={d.dir} kt={d.peak} size={13} />
                <span className="font-display text-base font-700" style={{ color }}>
                  {fmtWind(d.peak, unit)}
                </span>
                <span>{unitLabel(unit)}</span>
                <span>· Böen {fmtWind(d.gust, unit)}</span>
              </div>
              {d.modelPeak != null && d.peak != null && d.modelPeak - d.peak >= 1.5 && (
                <div
                  className="text-[11px] text-faint"
                  title="Gewichteter Median der Tages-Spitzen der einzelnen Modelle — unabhängig davon, zu welcher Stunde jedes Modell sie sieht"
                >
                  Modell-Spitze bis {fmtWind(d.modelPeak, unit)} {unitLabel(unit)}
                </div>
              )}
              {d.globalOnly && <div className="mt-0.5 text-[10px] uppercase tracking-wider text-faint">nur globale Modelle</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
