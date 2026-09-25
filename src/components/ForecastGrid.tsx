"use client";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { DIR_LABEL, TH, type DaySummary, type HourEval } from "@/lib/kite";
import { fmtDay, fmtWeekday, noonOf } from "@/lib/dates";
import { OFFSHORE_TINT, WindArrow, WindTile, hourOf } from "./ui";

// Stundenraster wie bei Windguru: 3-h-Schritte, nur Tageslicht (8, 11, 14, 17, 20 Uhr).
const STEP_H = 3;
const FIRST_H = 8;
// Immer bis einschließlich zum zweiten kommenden Sonntag zeigen (zwei Wochenenden).
const WEEKENDS = 2;
// Wochenende: kräftiger neutraler Rahmen — früher gelb, aber Amber heißt in den Kacheln
// „kräftig" und stand dann oft direkt daneben.
const WE_COLOR = "color-mix(in srgb, var(--color-ink) 45%, transparent)";
const WE_BG = "var(--tint-accent)";
// Nur Änderungen zeigen — ein „→ stabil" an jedem Tag war Rauschen.
const TREND_SYM = { steigt: "↗", fällt: "↘" } as const;

// Ab so viel Regen (mm/h) irgendwo im Raster bekommt ein Spot die Regenzeile.
const RAIN_ROW_MM = 1;

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = So, 6 = Sa

export type GridSpot = { spot: SpotPayload; hours: HourEval[]; days: DaySummary[] };
type Group = { day: string; wd: number; cols: number[] };

/**
 * EIN Raster für alle Spots: gemeinsame Zeitachse (Tage × Tageslicht-Stunden im 3-h-Takt),
 * darunter je Spot Wind, Böen, Richtung, Wahrscheinlichkeit, Regen (nur wenn es regnet) und
 * Temperatur. „Wann und wo?" ist so ein Blick von oben nach unten — früher standen zwei Raster
 * untereinander, die per Code gemeinsam scrollen mussten.
 *
 * Wochenenden umrahmt, fahrbare Stunden mit grünem Strich, unsichere Tage (nur globale
 * Modelle) blasser. Tippen auf den Spot-Namen öffnet den Spot, auf eine Stunde dessen Tag.
 */
export default function ForecastGrid({
  spots,
  unit,
  onOpen,
}: {
  spots: GridSpot[];
  unit: WindUnit;
  onOpen: (id: number, day?: string | null) => void;
}) {
  const nowSec = Date.now() / 1000;

  // Tage aller Spots bis zum zweiten Sonntag (soweit Daten reichen).
  const allDays = [...new Set(spots.flatMap((s) => s.days.map((d) => d.day)))].sort();
  const shownDays: string[] = [];
  let sundays = 0;
  for (const d of allDays) {
    shownDays.push(d);
    if (weekday(d) === 0 && ++sundays >= WEEKENDS) break;
  }

  const isCol = (h: HourEval) => h.daylight && h.t + 3600 > nowSec && (hourOf(h.t) - FIRST_H) % STEP_H === 0;
  const groups: Group[] = shownDays
    .map((day) => ({
      day,
      wd: weekday(day),
      // Vereinigung: geht die Sonne an einem Spot später unter, hat der andere dort eine Lücke.
      cols: [...new Set(spots.flatMap((s) => s.hours.filter((h) => h.day === day && isCol(h)).map((h) => h.t)))].sort(
        (a, b) => a - b,
      ),
    }))
    .filter((g) => g.cols.length);
  if (!groups.length) return null;

  const per = spots.map(({ spot, hours, days }) => {
    const hourAt = new Map(hours.map((h) => [h.t, h]));
    const pointAt = new Map(spot.points.map((p) => [p.t, p]));
    const cols = groups.flatMap((g) => g.cols);
    return {
      spot,
      hourAt,
      pointAt,
      dayAt: new Map(days.map((d) => [d.day, d])),
      // Regenzeile nur bei nennenswertem Regen — Niesel stand sonst fast immer irgendwo im
      // 16-Tage-Raster, und die Zeile bestand aus Punkten.
      hasRain: cols.some((t) => (pointAt.get(t)?.precip ?? 0) >= RAIN_ROW_MM || hourAt.get(t)?.squall),
    };
  });

  // Rahmen je Zelle: Tagestrenner links; Wochenende außen umrandet (Sa links, So rechts, unten
  // an der letzten Zeile des letzten Spots, oben am Tageskopf).
  const edge = (g: Group, i: number, o: { last?: boolean; dim?: boolean; sep?: boolean } = {}): React.CSSProperties => {
    const sat = g.wd === 6;
    const sun = g.wd === 0;
    const s: React.CSSProperties = {};
    if (i === 0) s.borderLeft = sat ? `1.5px solid ${WE_COLOR}` : "1px solid var(--color-border)";
    if (sun && i === g.cols.length - 1) s.borderRight = `1.5px solid ${WE_COLOR}`;
    if (o.sep) s.borderTop = "1px solid var(--color-border-soft)";
    if (sat || sun) {
      s.background = WE_BG;
      if (o.last) {
        s.borderBottom = `1.5px solid ${WE_COLOR}`;
        if (sat && i === 0) s.borderBottomLeftRadius = 6;
        if (sun && i === g.cols.length - 1) s.borderBottomRightRadius = 6;
      }
    }
    if (o.dim) s.opacity = 0.55;
    return s;
  };

  const cell = "h-[22px] min-w-[22px] p-[1px] text-center font-mono text-[11px] leading-[20px]";
  const labelCls =
    "sticky left-0 z-10 w-px whitespace-nowrap bg-[color:var(--color-panel)] pr-1.5 text-left text-[9px] font-600 uppercase tracking-wider text-muted";

  return (
    <div className="overflow-x-auto pb-1">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[color:var(--color-panel)]" />
            {groups.map((g) => {
              const sat = g.wd === 6;
              const sun = g.wd === 0;
              const we = sat || sun;
              const dimAll = per.every((p) => p.dayAt.get(g.day)?.globalOnly);
              return (
                <th
                  key={g.day}
                  colSpan={g.cols.length}
                  className="px-[3px] pt-0.5 text-left align-bottom"
                  title={(dimAll ? "nur globale Modelle — unsicher · " : "") + fmtDay(noonOf(g.day))}
                  style={{
                    borderLeft: sat ? `1.5px solid ${WE_COLOR}` : "1px solid var(--color-border)",
                    borderRight: sun ? `1.5px solid ${WE_COLOR}` : undefined,
                    borderTop: we ? `1.5px solid ${WE_COLOR}` : undefined,
                    borderTopLeftRadius: sat ? 6 : undefined,
                    borderTopRightRadius: sun ? 6 : undefined,
                    background: we ? WE_BG : undefined,
                    opacity: dimAll ? 0.55 : 1,
                  }}
                >
                  {/* Kurzer Tag (heute Abend: 1–2 Spalten) nur mit Wochentag — sonst streckte das
                      Datum die erste Spalte zu einer breiten Einzelkachel. */}
                  <div className="whitespace-nowrap text-[10px] text-ink" style={{ fontWeight: we ? 700 : 600 }}>
                    {g.cols.length <= 2 ? fmtWeekday(noonOf(g.day)) : fmtDay(noonOf(g.day))}
                  </div>
                </th>
              );
            })}
          </tr>
          <tr>
            <th className="sticky left-0 z-10 bg-[color:var(--color-panel)]" />
            {groups.map((g) =>
              g.cols.map((t, i) => (
                <th key={t} className="pb-[2px] text-center font-mono text-[9px] font-500 text-muted" style={edge(g, i)}>
                  {String(hourOf(t)).padStart(2, "0")}
                </th>
              )),
            )}
          </tr>
        </thead>

        {per.map((p, si) => {
          const lastSpot = si === per.length - 1;
          const dimOf = (g: Group) => !!p.dayAt.get(g.day)?.globalOnly;
          const open = (g: Group) => () => onOpen(p.spot.id, g.day);

          const row = (
            label: string,
            render: (h: HourEval, t: number) => React.ReactNode,
            o: { title?: string; last?: boolean } = {},
          ) => (
            <tr>
              <th className={labelCls} title={o.title}>
                {label}
              </th>
              {groups.map((g) =>
                g.cols.map((t, i) => {
                  const h = p.hourAt.get(t);
                  return (
                    <td
                      key={t}
                      className={`${cell} cursor-pointer`}
                      style={edge(g, i, { dim: dimOf(g), last: lastSpot && o.last })}
                      onClick={open(g)}
                    >
                      {h ? render(h, t) : null}
                    </td>
                  );
                }),
              )}
            </tr>
          );

          return (
            <tbody key={p.spot.id}>
              {/* Spot-Name: liegt über den leeren Zellen dieser Zeile, damit die Beschriftungs-
                  spalte schmal bleibt (am Handy zählt jede Spalte). */}
              <tr>
                <th className="sticky left-0 z-20 h-[26px] bg-[color:var(--color-panel)] p-0" style={si > 0 ? { borderTop: "1px solid var(--color-border-soft)" } : undefined}>
                  <button
                    type="button"
                    onClick={() => onOpen(p.spot.id)}
                    className="absolute bottom-[3px] left-0 whitespace-nowrap bg-[color:var(--color-panel)] pr-2 text-left font-display text-[13px] font-700 text-ink hover:underline"
                    title={`${p.spot.name} öffnen`}
                  >
                    {p.spot.name} <span className="font-sans text-faint">›</span>
                  </button>
                </th>
                {groups.map((g) =>
                  g.cols.map((t, i) => {
                    const tr = p.dayAt.get(g.day)?.trend;
                    const mark = i === g.cols.length - 1 && tr && tr.state !== "stabil" ? tr : null;
                    return (
                      <td
                        key={t}
                        className="h-[26px] pr-[3px] text-right align-bottom text-[11px] text-ink"
                        style={edge(g, i, { dim: dimOf(g), sep: si > 0 })}
                      >
                        {mark && (
                          <span title={`Tages-Wind ${mark.state} ${mark.since}`}>{TREND_SYM[mark.state as "steigt" | "fällt"]}</span>
                        )}
                      </td>
                    );
                  }),
                )}
              </tr>
              {/* Fahrbar-Markierung */}
              <tr>
                <th className="sticky left-0 z-10 bg-[color:var(--color-panel)] p-0" />
                {groups.map((g) =>
                  g.cols.map((t, i) => (
                    <td key={t} className="h-[5px] p-0" style={edge(g, i, { dim: dimOf(g) })}>
                      <span
                        className="mx-auto block h-[3px] w-[18px] rounded-full"
                        style={{ background: p.hourAt.get(t)?.rideable ? "var(--wg-green)" : "transparent" }}
                        title={p.hourAt.get(t)?.rideable ? "fahrbar" : undefined}
                      />
                    </td>
                  )),
                )}
              </tr>
              {row("Wind", (h) => <WindTile kt={h.wind} unit={unit} />, {
                title: `Wind in ${unit === "ms" ? "m/s" : "kn"} (Konsens inkl. Korrektur)`,
              })}
              {row("Böen", (h) => <WindTile kt={h.gust} unit={unit} />)}
              {row(
                "Richt.",
                (h) => {
                  // Getönt nur, wo der Wind überhaupt reicht (ab „knapp") — bei 3 kn ist die
                  // Richtung egal, und die Tönung wäre sonst die lauteste Fläche im Raster.
                  const relevant = (h.wind ?? 0) >= TH.min - 3;
                  const q = relevant ? h.dirQ : null;
                  return (
                    <span
                      className={`flex h-[20px] items-center justify-center rounded-[3px] ${q === "ok" ? "hatch" : ""}`}
                      style={q === "bad" ? { background: OFFSHORE_TINT } : undefined}
                      title={h.dirQ ? `${h.dir ?? "–"}° · ${DIR_LABEL[h.dirQ]}` : undefined}
                    >
                      <WindArrow dir={h.dir} kt={h.wind} size={13} />
                    </span>
                  );
                },
                { title: "Windrichtung — rot: ablandig/ungeeignet, schraffiert: bedingt (erst ab 10 kn markiert)" },
              )}
              {row(
                "%",
                (h) => {
                  const pct = h.pMin == null ? null : Math.round(h.pMin * 100);
                  return (
                    // Neutral: je sicherer, desto kräftiger — keine Windfarben für Prozente.
                    <span
                      style={{
                        color: pct == null ? undefined : pct >= 70 ? "var(--color-ink)" : pct >= 45 ? "var(--color-body)" : "var(--color-faint)",
                        fontWeight: pct != null && pct >= 70 ? 700 : undefined,
                      }}
                    >
                      {pct ?? "–"}
                    </span>
                  );
                },
                { title: `Wahrscheinlichkeit (%) für mindestens ${TH.min} kn` },
              )}
              {p.hasRain &&
                row(
                  "Regen",
                  (h, t) => {
                    const mm = p.pointAt.get(t)?.precip ?? null;
                    if (h.squall) return <span title="Schauerböen-Verdacht">⚡</span>;
                    return mm != null && mm >= 0.2 ? (
                      <span className="font-600 text-body">{mm >= 1 ? Math.round(mm) : mm.toFixed(1).replace(/^0/, "")}</span>
                    ) : null;
                  },
                  { title: "Regen (mm/h), ⚡ = Schauerböen-Verdacht" },
                )}
              {row(
                "°C",
                (_h, t) => {
                  const tmp = p.pointAt.get(t)?.tmp ?? null;
                  return <span className="text-body">{tmp == null ? "–" : Math.round(tmp)}</span>;
                },
                { title: "Lufttemperatur", last: true },
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
