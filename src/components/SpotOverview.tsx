"use client";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { ktColor } from "@/lib/palette";
import { ratingLabel, dirQuality, dirHint, DIR_LABEL, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { WindArrow, Compass, WindowLine, WaterTemps, WindScale, fmtWind } from "./ui";
import ForecastGrid from "./ForecastGrid";
import { NEAR_DAYS, lastNearDay } from "./Verdict";

// Wie viele kommende Fenster „in Sicht" je Spot in der Übersicht stehen.
const MAX_WINDOWS = 3;

/**
 * Startansicht unter der Kurzfassung: je Spot eine kompakte Karte (Wind jetzt — Messung, sonst
 * Prognose —, Wasser, Fahrfenster der nächsten Tage) und darunter EIN Kachel-Raster für beide
 * Spots. Ohne Fenster bleibt die Karte kurz: dass nichts geht, sagt die Kurzfassung schon.
 * Tippen öffnet den Spot bzw. direkt den Tag.
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
  const gridSpots = spots
    .filter((s) => !s.empty && (evals.get(s.id)?.days.length ?? 0) > 0)
    .map((s) => ({ spot: s, hours: evals.get(s.id)!.hours, days: evals.get(s.id)!.days }));

  return (
    <>
      <div className="mb-3 grid gap-3 sm:mb-4 lg:grid-cols-2">
        {spots.map((s) => {
          const ev = evals.get(s.id);
          const upcoming = (ev?.days ?? []).flatMap((d) => d.windows).filter((w) => w.end > nowSec);
          // In Sicht (≤ NEAR_DAYS). Fenster dahinter stehen einmal als Ausblick in der Kurzfassung.
          const near = upcoming.filter((w) => w.day <= lastNearDay(nowSec));
          const windows = near.slice(0, MAX_WINDOWS);
          const st = s.stations.find((x) => x.windAvg != null && (x.ageMin ?? 999) <= 90);
          const nowKt = st?.windAvg ?? s.now?.windspd ?? null;
          const nowDir = st?.windDir ?? s.now?.winddir ?? null;
          const dq = dirQuality(nowDir, s.dirs);
          const hint = dirHint(nowDir, s.dirs);

          return (
            <div key={s.id} className="panel min-w-0 p-4">
              <button type="button" onClick={() => onOpen(s.id)} className="flex w-full items-start justify-between gap-3 text-left" style={{ cursor: "pointer" }}>
                <div className="min-w-0">
                  <div className="whitespace-nowrap font-display text-lg font-700 text-ink">
                    {s.name} <span className="font-sans text-base font-500 text-faint">›</span>
                  </div>
                  <div className="text-[11px] text-faint">{s.region}</div>
                  <WaterTemps water={s.water} fallback={s.waterTemp} className="mt-1 block text-[11px] text-muted" />
                </div>
                {nowKt != null && (
                  // Darf schrumpfen: mit langem Hinweis („Richtung bedingt" + Spot-Tipp) quetschte
                  // eine starre rechte Spalte sonst Namen und Wassertemperatur links zusammen.
                  <div className="min-w-0 text-right">
                    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                      <WindArrow dir={nowDir} kt={nowKt} size={18} />
                      <span className="font-display text-3xl font-700 leading-none" style={{ color: ktColor(nowKt) }}>
                        {fmtWind(nowKt, unit)}
                      </span>
                      <span className="text-xs text-muted">{unitLabel(unit)}</span>
                    </div>
                    {/* Teile einzeln nicht umbrechen — sonst stand am Handy „zu | wenig". */}
                    <div className="mt-0.5 flex flex-wrap justify-end gap-x-1 text-[11px] text-muted">
                      <span className="whitespace-nowrap">{st ? "gemessen" : "Prognose"} ·</span>
                      <span className="whitespace-nowrap">
                        <Compass dir={nowDir} /> · {ratingLabel(nowKt, th)}
                      </span>
                      {dq === "bad" && <span className="whitespace-nowrap text-[color:var(--wg-red)]">· ablandig</span>}
                      {dq === "ok" && <span className="whitespace-nowrap font-600 text-ink">· {DIR_LABEL.ok}</span>}
                    </div>
                    {hint && <div className="max-w-[220px] text-[11px] text-faint">{hint}</div>}
                  </div>
                )}
              </button>

              {windows.length > 0 && (
                <div className="mt-3 border-t border-border-soft pt-2.5">
                  <div className="label mb-1.5">Fahrfenster in den nächsten {NEAR_DAYS} Tagen</div>
                  <ul className="grid gap-1.5">
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
                  {near.length > windows.length && <p className="mt-1 text-[11px] text-faint">+ {near.length - windows.length} weitere</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {gridSpots.length > 0 && (
        // Einfarbig statt Verlauf: die fest stehende Beschriftungsspalte trägt dieselbe Farbe und
        // hebt sich sonst als Streifen ab.
        <section className="panel mb-4 min-w-0 p-3 sm:mb-6 sm:p-4" style={{ background: "var(--color-panel)" }} aria-label="Kachel-Raster">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="label">Die nächsten Tage</span>
            <span className="text-[11px] text-faint">Tageslicht, alle 3 h · Tippen öffnet den Tag</span>
          </div>
          <ForecastGrid spots={gridSpots} unit={unit} onOpen={onOpen} />
          <div className="mt-2 border-t border-border-soft pt-2">
            <WindScale unit={unit} />
          </div>
        </section>
      )}
    </>
  );
}
