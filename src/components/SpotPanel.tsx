"use client";
import { useState } from "react";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { ktColor } from "@/lib/palette";
import { ratingLabel, dirQuality, dirHint, DIR_LABEL, type DaySummary, type HourEval, type Thresholds } from "@/lib/kite";
import { WindArrow, Compass, WaterTemps, fmtWind, relTime } from "./ui";
import DailyStrip from "./DailyStrip";
import ForecastChart from "./ForecastChart";
import TrendPanel from "./TrendPanel";
import Link from "next/link";
import DayDetail from "./DayDetail";

// Farben der gemessenen Stationen (identisch zu ForecastChart).
const STATION_COLORS = ["#f472b6", "#fbbf24", "#34d399"];

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
  const toneColor = now ? ktColor(now.windspd) : "var(--wg-grey)";
  const dq = dirQuality(now?.winddir ?? null, spot.dirs);
  const hint = dirHint(now?.winddir ?? null, spot.dirs);
  const nc = spot.nowcast;

  return (
    <section className="panel overflow-hidden">
      {/* Kopf */}
      <div className="flex items-start justify-between gap-3 border-b border-border-soft p-4 sm:p-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-xl font-700 text-ink">{spot.name}</h2>
            {!spot.empty && <span className="live-dot" title="Live-Datenstand" />}
          </div>
          <p className="text-xs text-muted">{spot.region}</p>
        </div>
        <div className="text-right text-xs text-muted">
          {spot.fetchedAt ? (
            <>
              <div>Stand {relTime(spot.fetchedAt)}</div>
              {spot.sunrise && spot.sunset && (
                <div className="mt-0.5">
                  ☀ {spot.sunrise}–{spot.sunset} · <WaterTemps water={spot.water} fallback={spot.waterTemp} />
                </div>
              )}
            </>
          ) : (
            <span>keine Daten</span>
          )}
        </div>
      </div>

      {spot.empty || !now ? (
        <div className="p-8 text-center text-sm text-muted">Warte auf ersten Datenabruf für {spot.name}…</div>
      ) : (
        <>
          {/* Aktuell */}
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4 p-4 sm:p-5">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted">Prognose jetzt</div>
              <div className="flex items-baseline gap-2">
                <span className="font-display text-5xl font-700 leading-none sm:text-6xl" style={{ color: toneColor }}>
                  {fmtWind(now.windspd, unit)}
                </span>
                <span className="text-sm text-muted">{unitLabel(unit)}</span>
              </div>
              <div className="mt-1 text-sm text-body">
                Böen <span className="font-mono text-ink">{fmtWind(now.gust, unit)}</span> {unitLabel(unit)}
                <span className="ml-2 chip" style={{ color: toneColor, borderColor: toneColor + "55" }}>
                  {ratingLabel(now.windspd, th)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <WindArrow dir={now.winddir} kt={now.windspd} size={44} />
              <div>
                <div className="font-display text-2xl text-ink">
                  <Compass dir={now.winddir} />
                </div>
                <div
                  className="text-xs"
                  style={{ color: dq === "bad" ? "var(--wg-red)" : dq === "ok" ? "var(--wg-amber)" : "var(--color-muted)" }}
                >
                  {now.winddir ?? "–"}° · {dq ? DIR_LABEL[dq] : "–"}
                </div>
                {hint && <div className="max-w-[220px] text-[11px] text-faint">{hint}</div>}
              </div>
            </div>

            {/* Gemessen (Live-Stationen) — mit Abgleich zur Prognose */}
            {spot.stations.map((st, i) =>
              st.windAvg == null ? null : (
                <div
                  key={st.id}
                  className="rounded-xl border border-border px-4 py-2"
                  style={{ borderColor: STATION_COLORS[i % STATION_COLORS.length] + "55" }}
                  title={st.obsTime ? `gemessen ${relTime(st.obsTime)} · Station ${st.name}` : undefined}
                >
                  <div className="text-xs uppercase tracking-wider" style={{ color: STATION_COLORS[i % STATION_COLORS.length] }}>
                    Gemessen · {st.name}
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-display text-3xl font-700 leading-none text-ink">{fmtWind(st.windAvg, unit)}</span>
                    <span className="text-sm text-muted">{unitLabel(unit)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    Böen <span className="font-mono text-body">{fmtWind(st.windMax, unit)}</span> · <Compass dir={st.windDir} />
                    {st.obsTime && <> · {relTime(st.obsTime)}</>}
                  </div>
                </div>
              ),
            )}

            <div className="flex gap-6">
              <Metric label="Temp" value={now.tmp != null ? `${Math.round(now.tmp)}°` : "–"} />
              <Metric label="gefühlt" value={now.tmpe != null ? `${Math.round(now.tmpe)}°` : "–"} />
              <Metric label="Wolken" value={now.cloud != null ? `${now.cloud}%` : "–"} />
              <Metric label="Modelle" value={String(now.n)} title="Anzahl Modelle im Konsens für diesen Zeitpunkt" />
            </div>
          </div>

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

/** Messung vs. Prognose jetzt — und was das für die nächsten Stunden heißt. */
function NowcastNote({ nc, unit }: { nc: NonNullable<SpotPayload["nowcast"]>; unit: WindUnit }) {
  const off = nc.offset;
  const u = unitLabel(unit);
  const abs = fmtWind(Math.abs(off), unit);
  const big = Math.abs(off) >= 2;
  const color = !big ? "#8a93a8" : off > 0 ? "#34d399" : "#fb7185";
  return (
    <div className="mx-4 mb-3 rounded-xl border px-3 py-2 text-sm sm:mx-5" style={{ borderColor: color + "55", background: color + "10" }}>
      <span className="text-muted">{nc.station} </span>
      <span className="font-mono text-ink">{fmtWind(nc.measured, unit)}</span>
      <span className="text-muted"> {u} / Prognose </span>
      <span className="font-mono text-ink">{fmtWind(nc.forecast, unit)}</span>
      <span className="text-muted"> {u} → </span>
      {big ? (
        <span style={{ color }}>
          Modelle {off > 0 ? "unterschätzen" : "überschätzen"} gerade um {abs} {u}. Die nächsten Stunden sind
          entsprechend korrigiert
          {nc.halfLifeH != null ? ` (nach ~${nc.halfLifeH} h gilt noch die Hälfte — aus den Daten gelernt)` : ""}; bei
          einem Winddreh über 60° endet die Korrektur.
        </span>
      ) : (
        <span className="text-body">
          Prognose passt (±{fmtWind(2, unit)} {u}).
        </span>
      )}
    </div>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
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
