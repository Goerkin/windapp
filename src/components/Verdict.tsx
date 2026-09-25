"use client";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { ktColor } from "@/lib/palette";
import { ratingLabel, TH, type DaySummary, type HourEval, type RideWindow } from "@/lib/kite";
import { WindowLine, dayKeyOf, fmtWind } from "./ui";

// So viele Kalendertage (heute mitgezählt) gilt ein Fenster als „in Sicht"; dahinter ist es
// Ausblick — meist rechnen dann nur noch die globalen Modelle, die Prozente sind entsprechend
// weich. Nach Tagen, nicht Stunden: sonst schnitte die Grenze mitten durch einen Tag.
export const NEAR_DAYS = 5;
export const lastNearDay = (nowSec: number) => dayKeyOf(nowSec + (NEAR_DAYS - 1) * 86400);

type Hit = { spot: SpotPayload; w: RideWindow };

const dowFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Amsterdam", weekday: "short", day: "numeric", month: "numeric" });
const dow = (sec: number) => dowFmt.format(new Date(sec * 1000)).replace(",", "");

/**
 * Die Antwort zuerst: eine Zeile über beiden Spots — geht heute/morgen etwas, wann ist die
 * nächste Chance, und was steht nur als (unsicherer) Ausblick da. Tippen öffnet den Tag.
 */
export default function Verdict({
  spots,
  evals,
  unit,
  nowSec,
  onOpen,
}: {
  spots: SpotPayload[];
  evals: Map<number, { hours: HourEval[]; days: DaySummary[] }>;
  unit: WindUnit;
  nowSec: number;
  onOpen: (id: number, day?: string | null) => void;
}) {
  const now = nowSec;
  const today = dayKeyOf(now);
  const tomorrow = dayKeyOf(now + 86400);
  const lastNear = lastNearDay(now);

  const hits: Hit[] = spots
    .flatMap((spot) => (evals.get(spot.id)?.days ?? []).flatMap((d) => d.windows.map((w) => ({ spot, w }))))
    .filter(({ w }) => w.end > now)
    .sort((a, b) => a.w.start - b.w.start);
  const soon = hits.filter(({ w }) => w.day === today || w.day === tomorrow);
  const near = hits.filter(({ w }) => w.day <= lastNear && w.day !== today && w.day !== tomorrow);
  // Ausblick: je Spot und Tag nur einmal nennen.
  const outlook = hits
    .filter(({ w }) => w.day > lastNear)
    .filter((h, i, arr) => arr.findIndex((x) => x.spot.id === h.spot.id && x.w.day === h.w.day) === i);

  // Ohne Fenster in Sicht: wo und wann weht in den nächsten 3 Tagen am meisten?
  const strongest = spots
    .flatMap((spot) =>
      (evals.get(spot.id)?.days ?? [])
        .filter((d) => d.peak != null && d.day >= today && d.day <= dayKeyOf(now + 2 * 86400))
        .map((d) => ({ spot, d })),
    )
    .sort((a, b) => (b.d.peak ?? 0) - (a.d.peak ?? 0))[0];

  const whenOf = (w: RideWindow) => (w.day === today ? "Heute" : w.day === tomorrow ? "Morgen" : dow(w.start));

  const row = (h: Hit, lead?: string) => (
    <button
      key={`${h.spot.id}-${h.w.start}`}
      type="button"
      onClick={() => onOpen(h.spot.id, h.w.day)}
      className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg px-2 py-1 text-left hover:bg-[color:var(--tint-accent)]"
    >
      {lead && <span className="font-display text-base font-700 text-ink">{lead}</span>}
      <span className="font-600 text-ink">{h.spot.name}</span>
      <span className="text-sm">
        <WindowLine w={h.w} unit={unit} />
      </span>
      {!h.w.hiRes && <span className="chip text-faint">unsicher</span>}
    </button>
  );

  return (
    <section className="panel mb-4 p-4 sm:mb-6 sm:p-5" aria-label="Kurzfassung">
      {soon.length ? (
        <div className="space-y-1">
          {soon.slice(0, 3).map((h) => row(h, whenOf(h.w)))}
        </div>
      ) : (
        <p className="font-display text-xl font-700 text-ink sm:text-2xl">Heute &amp; morgen nichts Fahrbares.</p>
      )}

      {!soon.length && near.length > 0 && (
        <div className="mt-2">
          <div className="label mb-0.5">Nächste Chance</div>
          {row(near[0], whenOf(near[0].w))}
        </div>
      )}

      {!soon.length && !near.length && strongest?.d.peak != null && (
        <button
          type="button"
          onClick={() => onOpen(strongest.spot.id, strongest.d.day)}
          className="mt-1 text-left text-sm text-muted hover:text-ink"
        >
          Am meisten Wind bis übermorgen: {strongest.d.label} {strongest.spot.name}{" "}
          <span className="font-600 tabular-nums" style={{ color: ktColor(strongest.d.peak) }}>
            {fmtWind(strongest.d.peak, unit)} {unitLabel(unit)}
          </span>{" "}
          ({ratingLabel(strongest.d.peak, TH)}).
        </button>
      )}

      {outlook.length > 0 && (
        <p className="mt-2 text-[12px] text-faint">
          Ausblick (nur globale Modelle, noch unsicher):{" "}
          {outlook.slice(0, 4).map((h, i) => (
            <span key={`${h.spot.id}-${h.w.start}`}>
              {i > 0 && " · "}
              <button type="button" onClick={() => onOpen(h.spot.id, h.w.day)} className="underline decoration-dotted underline-offset-2 hover:text-ink">
                {dow(h.w.start)} {h.spot.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
