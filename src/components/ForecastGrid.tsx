"use client";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { ktColorHex } from "@/lib/palette";
import { DIR_LABEL, type DaySummary, type HourEval } from "@/lib/kite";
import { WindArrow, fmtWind, hourOf } from "./ui";

// Stundenraster wie bei Windguru: 3-h-Schritte, nur Tageslicht (8, 11, 14, 17, 20 Uhr).
const STEP_H = 3;
const FIRST_H = 8;
// Immer bis einschließlich zum zweiten kommenden Sonntag zeigen (zwei Wochenenden).
const WEEKENDS = 2;
const WE_COLOR = "rgba(250,204,21,.55)";
const WE_BG = "rgba(250,204,21,.045)";

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = So, 6 = Sa
const TREND_SYM = { stabil: "→", steigt: "↗", fällt: "↘" } as const;
const TREND_COLOR = { stabil: "#8a93a8", steigt: "#34d399", fällt: "#fb7185" } as const;

/**
 * Kompakte Windguru-artige Tabelle: je Tag eine Spaltengruppe, je Stunde eine Spalte mit
 * farbigen Wind-/Böen-Kacheln, Richtungspfeil (Spot-Eignung), Wahrscheinlichkeit, Regen
 * und Temperatur. Wochenenden sind umrahmt, fahrbare Stunden grün markiert, unsichere Tage
 * (nur globale Modelle) blasser. So schmal, dass zwei Wochenenden auf einen Blick passen;
 * ist mehr Platz da, füllt die Tabelle die ganze Breite (Zellen wachsen mit).
 *
 * `scrollRef`/`onScroll` erlauben der Übersicht, mehrere Raster seitlich zu koppeln; die
 * Tageskopfzellen tragen dafür `data-day`.
 */
export default function ForecastGrid({
  spot,
  hours,
  days,
  unit,
  onOpenDay,
  scrollRef,
  onScroll,
}: {
  spot: SpotPayload;
  hours: HourEval[];
  days: DaySummary[];
  unit: WindUnit;
  onOpenDay?: (day: string) => void;
  scrollRef?: (el: HTMLDivElement | null) => void;
  onScroll?: (el: HTMLDivElement) => void;
}) {
  const nowSec = Date.now() / 1000;

  // Tage bis zum zweiten Sonntag (soweit Daten reichen).
  const shownDays: DaySummary[] = [];
  let sundays = 0;
  for (const d of days) {
    shownDays.push(d);
    if (weekday(d.day) === 0 && ++sundays >= WEEKENDS) break;
  }

  const groups = shownDays
    .map((d) => ({
      d,
      wd: weekday(d.day),
      cols: hours.filter(
        (h) => h.day === d.day && h.daylight && h.t + 3600 > nowSec && (hourOf(h.t) - FIRST_H) % STEP_H === 0,
      ),
    }))
    .filter((g) => g.cols.length);
  if (!groups.length) return null;

  const pointAt = new Map(spot.points.map((p) => [p.t, p]));
  const LAST_ROW = 5;

  // Rahmen je Zelle: Tagestrenner links; Wochenende außen umrandet (Sa links, So rechts,
  // unten an der letzten Zeile; oben am Tageskopf).
  const edge = (g: (typeof groups)[number], i: number, rowIdx: number): React.CSSProperties => {
    const sat = g.wd === 6;
    const sun = g.wd === 0;
    const s: React.CSSProperties = {};
    if (i === 0) s.borderLeft = sat ? `1.5px solid ${WE_COLOR}` : "1px solid var(--color-border)";
    if (sun && i === g.cols.length - 1) s.borderRight = `1.5px solid ${WE_COLOR}`;
    if (sat || sun) {
      s.background = WE_BG;
      if (rowIdx === LAST_ROW) {
        s.borderBottom = `1.5px solid ${WE_COLOR}`;
        if (sat && i === 0) s.borderBottomLeftRadius = 6;
        if (sun && i === g.cols.length - 1) s.borderBottomRightRadius = 6;
      }
    }
    if (g.d.globalOnly) s.opacity = 0.55;
    return s;
  };

  const cell = "h-[22px] min-w-[22px] p-[1px] text-center font-mono text-[11px] leading-[20px]";

  const row = (rowIdx: number, label: string, render: (h: HourEval) => React.ReactNode, title?: string) => (
    <tr>
      <th
        className="sticky left-0 z-10 w-px whitespace-nowrap bg-[color:var(--color-panel)] pr-1.5 text-left text-[9px] font-600 uppercase tracking-wider text-muted"
        title={title}
      >
        {label}
      </th>
      {groups.map((g) =>
        g.cols.map((h, i) => (
          <td key={h.t} className={cell} style={edge(g, i, rowIdx)}>
            {render(h)}
          </td>
        )),
      )}
    </tr>
  );

  const tile = (kt: number | null) =>
    kt == null ? (
      <span className="text-faint">–</span>
    ) : (
      <span className="block rounded-[3px] font-600" style={{ background: ktColorHex(kt) + "d9", color: "#0b1220" }}>
        {fmtWind(kt, unit)}
      </span>
    );

  return (
    <div className="overflow-x-auto pb-1" ref={scrollRef} onScroll={(e) => onScroll?.(e.currentTarget)}>
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[color:var(--color-panel)]" />
            {groups.map((g) => {
              const sat = g.wd === 6;
              const sun = g.wd === 0;
              const we = sat || sun;
              const tr = g.d.trend;
              return (
                <th
                  key={g.d.day}
                  data-day={g.d.day}
                  colSpan={g.cols.length}
                  className="px-[3px] pt-0.5 text-left align-bottom"
                  style={{
                    borderLeft: sat ? `1.5px solid ${WE_COLOR}` : "1px solid var(--color-border)",
                    borderRight: sun ? `1.5px solid ${WE_COLOR}` : undefined,
                    borderTop: we ? `1.5px solid ${WE_COLOR}` : undefined,
                    borderTopLeftRadius: sat ? 6 : undefined,
                    borderTopRightRadius: sun ? 6 : undefined,
                    background: we ? WE_BG : undefined,
                    opacity: g.d.globalOnly ? 0.55 : 1,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onOpenDay?.(g.d.day)}
                    className="w-full text-left hover:text-accent"
                    style={{ cursor: onOpenDay ? "pointer" : "default" }}
                    title={
                      (g.d.globalOnly ? "nur globale Modelle — unsicher · " : "") +
                      (tr ? `Tages-Wind ${tr.state} ${tr.since}` : "Tag öffnen")
                    }
                  >
                    <div
                      className="flex items-center gap-1 whitespace-nowrap text-[10px] font-600"
                      style={{ color: we ? "var(--wg-amber)" : "var(--color-ink)" }}
                    >
                      {g.d.label.replace(/\.$/, "")}
                      {tr && <span style={{ color: TREND_COLOR[tr.state] }}>{TREND_SYM[tr.state]}</span>}
                      {g.d.best && <span className="text-[color:var(--wg-green)]">●</span>}
                    </div>
                  </button>
                </th>
              );
            })}
          </tr>
          <tr>
            <th className="sticky left-0 z-10 bg-[color:var(--color-panel)]" />
            {groups.map((g) =>
              g.cols.map((h, i) => (
                <th key={h.t} className="pb-[1px] text-center font-mono text-[9px] font-500 text-muted" style={edge(g, i, -1)}>
                  {String(hourOf(h.t)).padStart(2, "0")}
                  <span
                    className="mx-auto mt-[1px] block h-[3px] w-[18px] rounded-full"
                    style={{ background: h.rideable ? "var(--wg-green)" : "transparent" }}
                    title={h.rideable ? "fahrbar" : undefined}
                  />
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {row(0, "Wind", (h) => tile(h.wind), `Wind in ${unit === "ms" ? "m/s" : "kn"} (Konsens inkl. Korrektur)`)}
          {row(1, "Böen", (h) => tile(h.gust))}
          {row(
            2,
            "Dir",
            (h) => (
              <span
                className="flex h-[20px] items-center justify-center rounded-[3px]"
                style={{
                  background:
                    h.dirQ === "bad" ? "rgba(239,68,68,.25)" : h.dirQ === "ok" ? "rgba(245,158,11,.2)" : "transparent",
                }}
                title={h.dirQ ? `${h.dir ?? "–"}° · ${DIR_LABEL[h.dirQ]}` : undefined}
              >
                <WindArrow dir={h.dir} kt={h.wind} size={13} />
              </span>
            ),
            "Windrichtung — rot: ablandig/ungeeignet, gelb: bedingt",
          )}
          {row(
            3,
            "%",
            (h) => {
              const p = h.pMin == null ? null : Math.round(h.pMin * 100);
              return (
                <span style={{ color: p == null ? undefined : p >= 70 ? "var(--wg-green)" : p >= 45 ? "var(--wg-amber)" : "var(--color-faint)" }}>
                  {p ?? "–"}
                </span>
              );
            },
            "Wahrscheinlichkeit (%) für mindestens 13 kn",
          )}
          {row(
            4,
            "mm",
            (h) => {
              const mm = pointAt.get(h.t)?.precip ?? null;
              if (h.squall) return <span title="Schauerböen-Verdacht">⚡</span>;
              return mm != null && mm >= 0.2 ? (
                <span className="text-[#60a5fa]">{mm >= 1 ? Math.round(mm) : mm.toFixed(1).replace(/^0/, "")}</span>
              ) : (
                <span className="text-faint">·</span>
              );
            },
            "Regen (mm/h), ⚡ = Schauerböen-Verdacht",
          )}
          {row(
            LAST_ROW,
            "°C",
            (h) => {
              const tmp = pointAt.get(h.t)?.tmp ?? null;
              return <span className="text-body">{tmp == null ? "–" : Math.round(tmp)}</span>;
            },
            "Lufttemperatur",
          )}
        </tbody>
      </table>
    </div>
  );
}
