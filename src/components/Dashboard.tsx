"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { TH as th, evaluateHours, summarizeDays } from "@/lib/kite";
import SpotPanel from "./SpotPanel";
import SpotOverview from "./SpotOverview";
import { relTime } from "./ui";

// Ab diesem Alter gilt der Datenstand als hängend und wird angemahnt. Der 24/7-Job zieht
// alle 30 min; die App holt selbst KEINE Daten mehr (ein Schreibpfad, nicht zwei).
const STALE_MIN = 45;

export default function Dashboard({
  initialSpots,
  initialError,
}: {
  initialSpots: SpotPayload[];
  initialError: string | null;
}) {
  const [spots, setSpots] = useState<SpotPayload[]>(initialSpots);
  const [unit, setUnit] = useState<WindUnit>("kn");
  const [activeId, setActiveId] = useState<number | null>(initialSpots[0]?.id ?? null);
  // Tages-Sprung aus der Übersicht; `nonce` erzwingt das Öffnen auch beim selben Tag.
  const [jump, setJump] = useState<{ day: string | null; nonce: number }>({ day: null, nonce: 0 });
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const evals = useMemo(
    () =>
      new Map(
        spots.map((s) => {
          const hours = s.empty ? [] : evaluateHours(s, th);
          return [s.id, { hours, days: s.empty ? [] : summarizeDays(s, hours) }];
        }),
      ),
    [spots],
  );

  const lastFetch = spots
    .map((s) => s.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) as string | undefined;

  const loadView = useCallback(async () => {
    const res = await fetch("/api/dashboard", { cache: "no-store" });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error ?? "Fehler beim Laden");
    setSpots(json.spots);
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await loadView();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loadView]);

  const ageMin = lastFetch ? (Date.now() - new Date(lastFetch).getTime()) / 60000 : null;
  const stale = ageMin != null && ageMin > STALE_MIN;

  // Ansicht alle 10 Minuten still neu laden (die Windguru-Abrufe macht der Job).
  useEffect(() => {
    const id = setInterval(() => void loadView().catch(() => {}), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadView]);

  const anyData = spots.some((s) => !s.empty);
  const activeSpot = spots.find((s) => s.id === activeId) ?? spots[0] ?? null;

  const openSpot = (id: number, day: string | null = null) => {
    setActiveId(id);
    setJump((j) => ({ day, nonce: j.nonce + 1 }));
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div className="flex items-center gap-2.5">
          <WindLogo />
          <div>
            <h1 className="font-display text-2xl font-700 leading-none text-ink sm:text-3xl">Wind Cockpit</h1>
            <p
              className="mt-1 text-[11px] text-faint"
              title="Referenz Twintip, 80 kg: fahrbar ab / gut ab / kräftig ab / zu viel ab"
            >
              fahrbar ab {th.min} · gut {th.good} · kräftig {th.strong} · zu viel {th.over} kn
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="seg" role="group" aria-label="Einheit">
            {(["kn", "ms"] as WindUnit[]).map((u) => (
              <button key={u} data-active={unit === u} onClick={() => setUnit(u)}>
                {u === "kn" ? "kn" : "m/s"}
              </button>
            ))}
          </div>
          <Link href="/analyse" className="chip hover:border-accent" title="Modellvergleich und Güte-Rückschau">
            Analyse
          </Link>
          <Link href="/hilfe" className="chip hover:border-accent" title="Was sehe ich hier und wie entstehen die Zahlen?">
            ? Hilfe
          </Link>
          {lastFetch && (
            <button
              onClick={refresh}
              disabled={busy}
              className="chip hover:border-accent"
              style={{ cursor: busy ? "wait" : "pointer", color: stale ? "var(--wg-amber)" : undefined }}
              title={
                stale
                  ? `Der Datenstand ist ${Math.round(ageMin!)} min alt — der Erfassungs-Job läuft alle 30 min. Klick lädt die Ansicht neu.`
                  : "Ansicht neu laden"
              }
            >
              <span className={busy ? "animate-spin" : ""}>↻</span>{" "}
              {busy ? "lädt…" : <>Stand {relTime(lastFetch)}</>}
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="panel-flat mb-4 border-l-2 p-4 text-sm" style={{ borderLeftColor: "var(--wg-red)" }}>
          <span className="text-body">Fehler beim Laden der Daten: {error}</span>
        </div>
      )}

      {!anyData && !error && (
        <div className="panel mb-6 p-8 text-center">
          <p className="font-display text-lg text-ink">Noch keine Daten</p>
          <p className="mt-2 text-sm text-muted">
            Die Erfassung läuft als eigener Job (alle 30 min), nicht in dieser Ansicht. Nach dem
            ersten Lauf steht hier etwas — Seite dann neu laden.
          </p>
        </div>
      )}

      {/* Übersicht: beide Spots + die nächsten guten Fenster — die Antwort auf „wann & wo?" */}
      {anyData && (
        <SpotOverview
          spots={spots}
          evals={evals}
          th={th}
          unit={unit}
          activeId={activeSpot?.id ?? null}
          onOpen={openSpot}
        />
      )}

      <div ref={panelRef} className="scroll-mt-4">
        {activeSpot && (
          <SpotPanel
            key={`${activeSpot.id}-${jump.nonce}`}
            spot={activeSpot}
            unit={unit}
            th={th}
            hours={evals.get(activeSpot.id)?.hours ?? []}
            days={evals.get(activeSpot.id)?.days ?? []}
            initialDay={jump.day}
          />
        )}
      </div>

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-faint">
        <p>
          Eigener Modell-Mix aus frei abrufbaren Windguru-Modelldaten, statistisch nachkorrigiert
          und gegen die Messstation geprüft. Privates Dashboard, nicht mit Windguru affiliiert.{" "}
          <Link href="/hilfe" className="underline hover:text-accent">
            Wie die Zahlen entstehen
          </Link>{" "}
          ·{" "}
          <Link href="/analyse" className="underline hover:text-accent">
            Modelle &amp; Genauigkeit
          </Link>
        </p>
      </footer>
    </div>
  );
}

function WindLogo() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path d="M3 8h11a3 3 0 1 0-3-3" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 13h15a3 3 0 1 1-3 3" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
      <path d="M3 18h8" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}
