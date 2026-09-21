"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { TH as th, evaluateHours, summarizeDays } from "@/lib/kite";
import SpotPanel from "./SpotPanel";
import SpotOverview from "./SpotOverview";
import { relTime } from "./ui";

// Ab diesem Alter des Datenstands holt „Aktualisieren" zuerst frische Windguru-Daten
// (der 24/7-Job läuft alle 30 min — meist reicht es, nur die Ansicht neu zu laden).
const STALE_MIN = 35;

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
  const [busy, setBusy] = useState<null | "view" | "pull">(null);
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

  // Ein Button für alles: Ansicht neu laden; ist der Datenstand älter als STALE_MIN, vorher
  // frische Windguru-Daten ziehen (in-App-Ingest, ~10–20 s).
  const refresh = useCallback(async () => {
    const ageMin = lastFetch ? (Date.now() - new Date(lastFetch).getTime()) / 60000 : Infinity;
    const pull = ageMin > STALE_MIN;
    setBusy(pull ? "pull" : "view");
    setError(null);
    try {
      if (pull) {
        const res = await fetch("/api/ingest?force=1", { method: "POST" });
        const json = await res.json();
        if (!json.ok) setError(json.error ?? "Datenabruf fehlgeschlagen");
      }
      await loadView();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [lastFetch, loadView]);

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
      <header className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <WindLogo />
            <h1 className="font-display text-2xl font-700 text-ink sm:text-3xl">Wind Cockpit</h1>
          </div>
          <button
            onClick={refresh}
            disabled={busy != null}
            className="chip hover:border-accent sm:hidden"
            style={{ cursor: busy ? "wait" : "pointer" }}
          >
            <span className={busy ? "animate-spin" : ""}>↻</span> {busy === "pull" ? "hole Daten…" : busy ? "lädt…" : "Aktualisieren"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Link href="/hilfe" className="chip hover:border-accent" title="Was sehe ich hier und wie entstehen die Zahlen?">
            ? Hilfe
          </Link>
          <div className="seg" role="group" aria-label="Einheit">
            {(["kn", "ms"] as WindUnit[]).map((u) => (
              <button key={u} data-active={unit === u} onClick={() => setUnit(u)}>
                {u === "kn" ? "kn" : "m/s"}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-faint" title="Referenz Twintip, 80 kg: fahrbar ab / gut ab / kräftig ab / zu viel ab">
            ab {th.min} · gut {th.good} · kräftig {th.strong} · max {th.over} kn
          </span>
          <div className="hidden items-center gap-2 text-xs text-muted sm:flex">
            {lastFetch && (
              <span>
                Datenstand <span className="text-body">{relTime(lastFetch)}</span>
              </span>
            )}
            <button
              onClick={refresh}
              disabled={busy != null}
              className="chip hover:border-accent"
              style={{ cursor: busy ? "wait" : "pointer" }}
              title={`Ansicht neu laden — ist der Datenstand älter als ${STALE_MIN} min, werden vorher frische Windguru-Daten geholt`}
            >
              <span className={busy ? "animate-spin" : ""}>↻</span>{" "}
              {busy === "pull" ? "hole neue Daten…" : busy ? "lädt…" : "Aktualisieren"}
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="panel-flat mb-4 border-l-2 p-4 text-sm" style={{ borderLeftColor: "#fb7185" }}>
          <span className="text-body">Fehler beim Laden der Daten: {error}</span>
        </div>
      )}

      {!anyData && !error && (
        <div className="panel mb-6 p-8 text-center">
          <p className="font-display text-lg text-ink">Noch keine Daten</p>
          <p className="mt-2 text-sm text-muted">
            Der Server ruft die Windguru-Daten gleich zum ersten Mal ab. Lade die Seite in ein
            bis zwei Minuten neu – oder tippe auf „Aktualisieren".
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
          Der „Konsens" ist ein eigener Modell-Mix: je Stunde ein gewichtetes Mittel über alle
          verfügbaren Modelle. Jedes Modell wird vorher statistisch nachkorrigiert (systematischer
          Fehler an diesem Spot, je nach Vorlauf, Richtung und ggf. Windstärke/Temperatur) und nach
          seinem Restfehler gewichtet. Welche Variante gilt, entscheidet eine ehrliche Rückschau
          gegen die Messstation. In den nächsten Stunden fließt die aktuelle Abweichung der Station
          ein. Prozentangaben sind kalibrierte Wahrscheinlichkeiten für den Mindestwind (Referenz:
          Twintip, 80 kg). Daten: frei abrufbare Windguru-Modelldaten; privates Dashboard, nicht mit
          Windguru affiliiert.{" "}
          <Link href="/hilfe" className="underline hover:text-accent">
            Mehr dazu in der Hilfe.
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
