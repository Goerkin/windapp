"use client";
import { useState } from "react";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { ktColor, stationColor } from "@/lib/palette";
import { ratingLabel, dirQuality, dirHint, DIR_LABEL, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { WindArrow, Compass, WaterTemps, SunIcon, fmtWind, relTime } from "./ui";
import DailyStrip from "./DailyStrip";
import ForecastChart from "./ForecastChart";
import TrendPanel from "./TrendPanel";
import Link from "next/link";
import DayDetail from "./DayDetail";

type Tab = "overview" | "day";

export default function SpotPanel({
  spot,
  unit,
  th,
  hours,
  days,
  initialDay,
}: {
  spot: SpotPayload;
  unit: WindUnit;
  th: Thresholds;
  hours: HourEval[];
  days: DaySummary[];
  initialDay?: string | null;
}) {
  const [tab, setTab] = useState<Tab>(initialDay ? "day" : "overview");
  const [selectedDay, setSelectedDay] = useState<string | null>(initialDay ?? null);
  const openDay = (day: string) => {
    setSelectedDay(day);
    setTab("day");
  };
  const now = spot.now;
  // Wind jetzt wie in der Übersicht: Messung (≤ 90 min alt), sonst Prognose. Früher stand hier
  // die Prognose groß und die Messung klein daneben — nach dem Tippen sprang die große Zahl
  // von 6 auf 2, und mit der Korrektur-Zeile standen vier Werte für „jetzt" da.
  const stIdx = spot.stations.findIndex((x) => x.windAvg != null && (x.ageMin ?? 999) <= 90);
  const st = stIdx >= 0 ? spot.stations[stIdx] : null;
  const heroKt = st?.windAvg ?? now?.windspd ?? null;
  const heroGust = st ? st.windMax : (now?.gust ?? null);
  const heroDir = st?.windDir ?? now?.winddir ?? null;
  const airTemp = st?.temp ?? now?.tmp ?? null;
  const others = spot.stations.filter((x, i) => i !== stIdx && x.windAvg != null && (x.ageMin ?? 999) <= 90);
  const toneColor = ktColor(heroKt);
  const dq = dirQuality(heroDir, spot.dirs);
  const hint = dirHint(heroDir, spot.dirs);
  const nc = spot.nowcast;

  return (
    <section className="panel overflow-hidden">
      {/* Kopf */}
      <div className="border-b border-border-soft p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-700 text-ink">{spot.name}</h2>
            <p className="text-xs text-muted">{spot.region}</p>
          </div>
          <div className="text-right text-xs text-muted">{spot.fetchedAt ? `Stand ${relTime(spot.fetchedAt)}` : "keine Daten"}</div>
        </div>
        {/* Eigene Zeile über die volle Breite — rechts neben dem Namen war sie am Handy auf vier
            Zeilen gequetscht. */}
        {spot.fetchedAt && spot.sunrise && spot.sunset && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span className="whitespace-nowrap">
              <SunIcon /> {spot.sunrise}–{spot.sunset}
            </span>
            <WaterTemps water={spot.water} fallback={spot.waterTemp} />
          </div>
        )}
      </div>

      {spot.empty || !now ? (
        <div className="p-8 text-center text-sm text-muted">Warte auf ersten Datenabruf für {spot.name}…</div>
      ) : (
        <>
          {/* Jetzt */}
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4 p-4 sm:p-5">
            <div>
              <div className="label" style={st ? { color: stationColor(stIdx) } : undefined}>
                {st ? `Gemessen · ${st.name}` : "Prognose jetzt"}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-display text-5xl font-700 leading-none sm:text-6xl" style={{ color: toneColor }}>
                  {fmtWind(heroKt, unit)}
                </span>
                <span className="text-sm text-muted">{unitLabel(unit)}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-body">
                <span className="whitespace-nowrap">
                  Böen <span className="font-mono text-ink">{fmtWind(heroGust, unit)}</span> {unitLabel(unit)}
                </span>
                <span className="chip" style={{ color: toneColor, borderColor: `color-mix(in srgb, ${toneColor} 35%, transparent)` }}>
                  {ratingLabel(heroKt, th)}
                </span>
                {st?.obsTime && <span className="whitespace-nowrap text-xs text-muted">{relTime(st.obsTime)}</span>}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <WindArrow dir={heroDir} kt={heroKt} size={44} />
              <div>
                <div className="font-display text-2xl text-ink">
                  <Compass dir={heroDir} />
                </div>
                <div
                  className="text-xs"
                  style={{
                    color: dq === "bad" ? "var(--wg-red)" : dq === "ok" ? "var(--color-ink)" : "var(--color-muted)",
                    fontWeight: dq === "ok" ? 600 : undefined,
                  }}
                >
                  {heroDir ?? "–"}° · {dq ? DIR_LABEL[dq] : "–"}
                </div>
                {hint && <div className="max-w-[220px] text-[11px] text-faint">{hint}</div>}
              </div>
            </div>

            <div className="flex gap-6">
              <Metric
                label="Luft"
                value={airTemp != null ? `${Math.round(airTemp)}°` : "–"}
                title={st?.temp != null ? `gemessen · ${st.name}` : "Prognose"}
              />
              <Metric label="Wolken" value={now.cloud != null ? `${now.cloud}\u00a0%` : "–"} />
              <Metric label="Modelle" value={String(now.n)} title="Anzahl Modelle im Konsens für diesen Zeitpunkt" />
            </div>
          </div>

          {others.length > 0 && (
            <p className="-mt-2 px-4 pb-3 text-xs text-muted sm:px-5">
              Auch gemessen:{" "}
              {others.map((o, i) => (
                <span key={o.id} className="whitespace-nowrap">
                  {i > 0 && " · "}
                  <span style={{ color: stationColor(spot.stations.indexOf(o)) }}>{o.name}</span>{" "}
                  <span className="font-mono text-ink">{fmtWind(o.windAvg, unit)}</span> {unitLabel(unit)}
                </span>
              ))}
            </p>
          )}

          {nc && <NowcastNote nc={nc} unit={unit} />}

          {/* Tagesstreifen — Karten öffnen die Tages-Detailansicht */}
          <DailyStrip days={days} unit={unit} onSelect={openDay} activeDay={tab === "day" ? selectedDay : null} />

          {/* Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto px-4 pt-2 sm:px-5">
            <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
              Verlauf
            </TabButton>
            <TabButton active={tab === "day"} onClick={() => setTab("day")}>
              Tag
            </TabButton>
            {/* Modellvergleich und Güte-Rückschau liegen auf /analyse — sie beantworten eine
                andere Frage als „wann kann ich fahren?" und lagen hier zu tief verschachtelt. */}
            <Link href="/analyse" className="tab-btn ml-auto shrink-0" title="Modellvergleich und Güte-Rückschau">
              Analyse ↗
            </Link>
          </div>

          <div className="p-4 pt-3 sm:p-5 sm:pt-3">
            {tab === "overview" && (
              <>
                <ForecastChart spot={spot} unit={unit} th={th} hours={hours} days={days} />
                <details className="mt-5 rounded-xl border border-border-soft">
                  <summary className="cursor-pointer select-none px-4 py-2.5 text-sm text-body">
                    Trend — wie sich die Vorhersage über die letzten Datenstände verändert hat
                  </summary>
                  <div className="px-4 pb-4">
                    <TrendPanel spot={spot} unit={unit} />
                  </div>
                </details>
              </>
            )}
            {tab === "day" && (
              <DayDetail
                spot={spot}
                unit={unit}
                th={th}
                hours={hours}
                days={days}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Eine Zeile: wie weit lag die Prognose zuletzt neben der Messung, und was heißt das für die
 * nächsten Stunden. Die Einzelwerte (Messung Ø ~60 min, Prognose) stehen im Tooltip — neben der
 * großen Messzahl oben wären es sonst wieder mehrere Werte für „jetzt". Bewusst neutral: eine
 * Information, keine Warnung (Rot bleibt „gefährlich/ablandig").
 */
function NowcastNote({ nc, unit }: { nc: NonNullable<SpotPayload["nowcast"]>; unit: WindUnit }) {
  const off = nc.offset;
  const u = unitLabel(unit);
  return (
    <p
      className="mx-4 mb-3 rounded-xl border border-border-soft bg-[color:var(--tint-neutral)] px-3 py-2 text-sm text-body sm:mx-5"
      title={`${nc.station}: gemessen ${fmtWind(nc.measured, unit)} ${u} (Ø der letzten ~60 min), Prognose ${fmtWind(nc.forecast, unit)} ${u}. Bei einem Winddreh über 60° endet die Korrektur.`}
    >
      {Math.abs(off) >= 2 ? (
        <>
          Prognose lag zuletzt{" "}
          <span className="whitespace-nowrap font-600 tabular-nums text-ink">
            {fmtWind(Math.abs(off), unit)} {u} zu {off > 0 ? "niedrig" : "hoch"}
          </span>{" "}
          — die nächsten Stunden sind angepasst
          {nc.halfLifeH != null && <span className="text-muted">, nach ~{nc.halfLifeH}&nbsp;h noch zur Hälfte</span>}.
        </>
      ) : (
        <>
          Prognose passt zur Messung{" "}
          <span className="whitespace-nowrap text-muted">
            (±{fmtWind(2, unit)} {u})
          </span>
          .
        </>
      )}
    </p>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-display text-xl text-ink">{value}</div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="tab-btn" data-active={active} onClick={onClick}>
      {children}
    </button>
  );
}
