"use client";
import { useCallback, useRef } from "react";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { ktColor } from "@/lib/palette";
import { ratingLabel, dirQuality, dirHint, DIR_LABEL, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { WindArrow, Compass, WindowLine, WaterTemps, fmtWind } from "./ui";
import ForecastGrid from "./ForecastGrid";
import { NEAR_DAYS, lastNearDay } from "./Verdict";

// Wie viele kommende Fenster „in Sicht" je Spot in der Übersicht stehen.
const MAX_WINDOWS = 3;
const outlookFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Amsterdam", weekday: "short", day: "numeric", month: "numeric" });

/**
 * Startansicht: je Spot eine Karte in voller Breite mit Wind jetzt (Messung, sonst Prognose),
 * den nächsten fahrbaren Fenstern und darunter dem Windguru-artigen Kachel-Raster über die
 * nächsten Tage. Tippen öffnet den Spot bzw. direkt den Tag.
 */
export default function SpotOverview({
  spots,
  evals,
  th,
  unit,
  onOpen,
}: {
  spots: SpotPayload[];
  evals: Map<number, { hours: HourEval[]; days: DaySummary[] }>;
  th: Thresholds;
  unit: WindUnit;
  onOpen: (id: number, day?: string | null) => void;
}) {
  const nowSec = Date.now() / 1000;

  // Seitliches Scrollen der Kachel-Raster koppeln: der Tag am linken Rand (samt Anteil)
  // wird im anderen Raster an dieselbe Stelle geschoben. `expected` fängt das Echo-Event
  // des programmatischen Scrollens ab, damit sich die Raster nicht gegenseitig schieben.
  const scrollers = useRef(new Map<number, HTMLDivElement>());
  const expected = useRef(new WeakMap<HTMLDivElement, number>());
  const syncScroll = useCallback((srcId: number, el: HTMLDivElement) => {
    const exp = expected.current.get(el);
    if (exp != null && Math.abs(el.scrollLeft - exp) < 2) {
      expected.current.delete(el);
      return;
    }
    const heads = [...el.querySelectorAll<HTMLElement>("th[data-day]")];
    if (!heads.length) return;
    const x = el.scrollLeft + heads[0].offsetLeft; // linker Rand hinter der Beschriftungsspalte
    const anchor = heads.find((h) => h.offsetLeft + h.offsetWidth > x) ?? heads[heads.length - 1];
    const frac = Math.max(0, Math.min(1, (x - anchor.offsetLeft) / anchor.offsetWidth));
    const day = anchor.dataset.day!;
    for (const [id, other] of scrollers.current) {
      if (id === srcId) continue;
      const oh = [...other.querySelectorAll<HTMLElement>("th[data-day]")];
      if (!oh.length) continue;
      const target = oh.find((h) => h.dataset.day === day) ?? oh.find((h) => h.dataset.day! > day) ?? oh[oh.length - 1];
      const left = Math.max(0, target.offsetLeft - oh[0].offsetLeft + frac * target.offsetWidth);
      if (Math.abs(other.scrollLeft - left) < 2) continue;
      expected.current.set(other, left);
      other.scrollLeft = left;
    }
  }, []);

  return (
    <div className="mb-4 grid gap-3 sm:mb-6">
      {spots.map((s) => {
        const ev = evals.get(s.id);
        const upcoming = (ev?.days ?? []).flatMap((d) => d.windows).filter((w) => w.end > nowSec);
        // In Sicht (≤ NEAR_DAYS) groß; alles dahinter nur als Ausblick-Zeile — ein Fenster in
        // zwei Wochen, das nur die globalen Modelle sehen, ist nicht so wichtig wie eins morgen.
        const lastNear = lastNearDay(nowSec);
        const windows = upcoming.filter((w) => w.day <= lastNear).slice(0, MAX_WINDOWS);
        const outlook = upcoming
          .filter((w) => w.day > lastNear)
          .filter((w, i, arr) => arr.findIndex((x) => x.day === w.day) === i);
        const st = s.stations.find((x) => x.windAvg != null && (x.ageMin ?? 999) <= 90);
        const nowKt = st?.windAvg ?? s.now?.windspd ?? null;
        const nowDir = st?.windDir ?? s.now?.winddir ?? null;
        const dq = dirQuality(nowDir, s.dirs);
        const hint = dirHint(nowDir, s.dirs);
        const moreNear = upcoming.filter((w) => w.day <= lastNear).length - windows.length;

        return (
          <div key={s.id} className="panel min-w-0 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
            <button type="button" onClick={() => onOpen(s.id)} className="flex w-full items-start justify-between gap-3 text-left lg:w-[380px] lg:shrink-0" style={{ cursor: "pointer" }}>
              <div>
                <div className="font-display text-lg font-700 text-ink">{s.name}</div>
                <div className="text-[11px] text-faint">{s.region}</div>
                <WaterTemps water={s.water} fallback={s.waterTemp} className="mt-1 block text-[11px] text-muted" />
              </div>
              {nowKt != null && (
                <div className="text-right">
                  <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                    <WindArrow dir={nowDir} kt={nowKt} size={18} />
                    <span className="font-display text-3xl font-700 leading-none" style={{ color: ktColor(nowKt) }}>
                      {fmtWind(nowKt, unit)}
                    </span>
                    <span className="text-xs text-muted">{unitLabel(unit)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {st ? "gemessen" : "Prognose"} · <Compass dir={nowDir} /> · {ratingLabel(nowKt, th)}
                    {dq === "bad" && <span className="ml-1 text-[color:var(--wg-red)]">· ablandig</span>}
                    {dq === "ok" && <span className="ml-1 text-[color:var(--wg-amber)]">· {DIR_LABEL.ok}</span>}
                  </div>
                  {hint && <div className="text-[11px] text-faint">{hint}</div>}
                </div>
              )}
            </button>

            <div className="min-w-0 flex-1 border-t border-border-soft pt-2.5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              <div className="label mb-1.5">Fahrfenster in den nächsten {NEAR_DAYS} Tagen</div>
              {windows.length ? (
                <ul className="grid gap-1.5 xl:grid-cols-2">
                  {windows.map((w) => (
                    <li key={w.start}>
                      <button
                        type="button"
                        onClick={() => onOpen(s.id, w.day)}
                        className="w-full rounded-lg border border-border-soft px-2.5 py-1.5 text-left text-sm hover:border-accent"
                        style={{ cursor: "pointer" }}
                        title={w.hiRes ? undefined : "nur globale Modelle — noch unsicher"}
                      >
                        <WindowLine w={w} unit={unit} withDay />
                        {!w.hiRes && <span className="chip ml-1.5 align-middle text-faint">unsicher</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Keins — zu wenig Wind, falsche Richtung oder dunkel.</p>
              )}
              {moreNear > 0 && <p className="mt-1 text-[11px] text-faint">+ {moreNear} weitere</p>}
              {outlook.length > 0 && (
                <p className="mt-1.5 text-[11px] text-faint">
                  Ausblick, noch unsicher:{" "}
                  {outlook.slice(0, 4).map((w, i) => (
                    <span key={w.start}>
                      {i > 0 && " · "}
                      <button type="button" onClick={() => onOpen(s.id, w.day)} className="underline decoration-dotted underline-offset-2 hover:text-ink">
                        {outlookFmt.format(new Date(w.start * 1000)).replace(",", "")}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </div>
            </div>

            {ev && ev.days.length > 0 && (
              <div className="mt-3 border-t border-border-soft pt-3">
                <ForecastGrid
                  spot={s}
                  hours={ev.hours}
                  days={ev.days}
                  unit={unit}
                  onOpenDay={(day) => onOpen(s.id, day)}
                  scrollRef={(el) => {
                    if (el) scrollers.current.set(s.id, el);
                    else scrollers.current.delete(s.id);
                  }}
                  onScroll={(el) => syncScroll(s.id, el)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
