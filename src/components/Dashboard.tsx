"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import { TH as th, evaluateHours, summarizeDays } from "@/lib/kite";
import SpotPanel from "./SpotPanel";
import SpotOverview from "./SpotOverview";
import Verdict from "./Verdict";
import { relTime } from "./ui";
import { useUnit } from "./useUnit";

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
  const [unit, setUnit] = useUnit();
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

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

  const nowMs = Date.now();
  const ageMin = lastFetch ? (nowMs - new Date(lastFetch).getTime()) / 60000 : null;
  const stale = ageMin != null && ageMin > STALE_MIN;

  // Ansicht alle 10 Minuten still neu laden (die Windguru-Abrufe macht der Job).
  // Zusätzlich beim Zurückkommen in den Vordergrund: als Homescreen-App wird die Seite nicht
  // neu geladen, sondern aufgeweckt — das Intervall stand währenddessen still, und ohne diesen
  // Nachzug zeigt die App beim Aufklappen stundenalte Zahlen.
  useEffect(() => {
    const id = setInterval(() => void loadView().catch(() => {}), 10 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadView().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadView]);

  const anyData = spots.some((s) => !s.empty);

  // Detail eines Spots als eigene Ansicht (statt unter der Übersicht gestapelt — dort stand fast
  // alles doppelt). Über den Browser-Verlauf, damit Zurück-Geste/-Taste zur Übersicht führt,
  // und mit #slug in der Adresse; ohne Neuladen (die Homescreen-App wird nur geweckt).
  const [view, setView] = useState<{ id: number; day: string | null; nonce: number } | null>(null);
  const openSpot = useCallback(
    (id: number, day: string | null = null) => {
      const slug = spots.find((x) => x.id === id)?.slug ?? String(id);
      const replace = view != null; // Spotwechsel im Detail: kein zusätzlicher Verlaufseintrag
      history[replace ? "replaceState" : "pushState"]({ wc: id, day }, "", `#${slug}`);
      setView((v) => ({ id, day, nonce: (v?.nonce ?? 0) + 1 }));
      window.scrollTo({ top: 0 });
    },
    [spots, view],
  );
  const backToOverview = () => {
    if (history.state?.wc != null) history.back();
    else setView(null);
  };
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = e.state as { wc?: number; day?: string | null } | null;
      setView(st?.wc != null ? { id: st.wc, day: st.day ?? null, nonce: Date.now() } : null);
    };
    window.addEventListener("popstate", onPop);
    // Direkt mit #slug geöffnet (Lesezeichen, geteilter Link)?
    const slug = decodeURIComponent(location.hash.slice(1));
    const hit = slug && spots.find((x) => x.slug === slug);
    // Erst nach dem ersten Bild umschalten: der Server kennt die Adresse ohne #slug nicht und
    // rendert die Übersicht; beim Hydrieren muss dasselbe herauskommen.
    const raf = hit
      ? requestAnimationFrame(() => {
          history.replaceState({ wc: hit.id, day: null }, "", location.hash);
          setView({ id: hit.id, day: null, nonce: 1 });
        })
      : 0;
    return () => {
      window.removeEventListener("popstate", onPop);
      cancelAnimationFrame(raf);
    };
    // Nur beim Start — spätere Datenstände ändern die Slugs nicht.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const detail = view ? spots.find((x) => x.id === view.id) ?? null : null;

  const nav = (
    <>
      <Link href="/analyse" className="chip hover:border-accent" title="Modellvergleich und Güte-Rückschau">
        Analyse
      </Link>
      <Link href="/hilfe" className="chip hover:border-accent" title="Was sehe ich hier und wie entstehen die Zahlen?">
        Hilfe
      </Link>
    </>
  );
  const refreshBtn = lastFetch && (
    <button
      onClick={refresh}
      disabled={busy}
      className="chip shrink-0 hover:border-accent"
      style={{ cursor: busy ? "wait" : "pointer", color: stale ? "var(--wg-amber)" : undefined }}
      title={
        stale
          ? `Der Datenstand ist ${Math.round(ageMin!)} min alt — der Erfassungs-Job läuft alle 30 min. Klick lädt die Ansicht neu.`
          : "Ansicht neu laden"
      }
    >
      <span className={busy ? "animate-spin" : ""}>↻</span> {busy ? "lädt…" : relTime(lastFetch)}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      {/* Eine Zeile, auch am Handy: die Antwort soll oben stehen, nicht hinter zwei Zeilen
          Bedienung. Analyse/Hilfe stehen am Handy im Fuß, die Einheit überall dort. */}
      <header className="mb-3 flex items-center justify-between gap-3 sm:mb-5">
        <button type="button" onClick={detail ? backToOverview : undefined} className="flex min-w-0 items-center gap-2.5 text-left">
          <WindLogo />
          <h1 className="font-display text-xl font-700 leading-none text-ink sm:text-3xl">Wind Cockpit</h1>
        </button>
        <div className="flex items-center gap-2 sm:gap-3">
          <nav className="hidden items-center gap-3 sm:flex">{nav}</nav>
          {refreshBtn}
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

      {detail ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={backToOverview} className="chip hover:border-accent">
              ← Übersicht
            </button>
            {spots.length > 1 && (
              <div className="seg" role="group" aria-label="Spot">
                {spots.map((x) => (
                  <button key={x.id} data-active={x.id === detail.id} onClick={() => openSpot(x.id)}>
                    {x.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <SpotPanel
            key={`${detail.id}-${view!.nonce}`}
            spot={detail}
            unit={unit}
            th={th}
            hours={evals.get(detail.id)?.hours ?? []}
            days={evals.get(detail.id)?.days ?? []}
            initialDay={view!.day}
          />
        </>
      ) : (
        anyData && (
          <>
            {/* Die Antwort zuerst — dann je Spot Details und das Kachel-Raster. */}
            <Verdict spots={spots} evals={evals} unit={unit} nowSec={nowMs / 1000} onOpen={openSpot} />
            <SpotOverview spots={spots} evals={evals} th={th} unit={unit} onOpen={openSpot} />
          </>
        )
      )}

      <footer className="mt-8 border-t border-border-soft pt-4 text-xs text-faint">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {nav}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-muted">Einheit</span>
            <span className="seg" role="group" aria-label="Einheit">
              {(["kn", "ms"] as WindUnit[]).map((u) => (
                <button key={u} data-active={unit === u} onClick={() => setUnit(u)}>
                  {u === "kn" ? "kn" : "m/s"}
                </button>
              ))}
            </span>
          </span>
        </div>
        <p>
          Eigener Modell-Mix aus frei abrufbaren Windguru-Modelldaten, statistisch nachkorrigiert
          und gegen die Messstation geprüft. Privates Dashboard, nicht mit Windguru affiliiert.
          Referenz für die Stufen: Twintip, 80 kg.
        </p>
      </footer>
    </div>
  );
}

function WindLogo() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" className="shrink-0" aria-hidden>
      <path d="M3 8h11a3 3 0 1 0-3-3" style={{ stroke: "var(--wg-teal)" }} strokeWidth="2" strokeLinecap="round" />
      <path d="M3 13h15a3 3 0 1 1-3 3" style={{ stroke: "var(--wg-teal)" }} strokeWidth="2" strokeLinecap="round" opacity="0.7" />
      <path d="M3 18h8" style={{ stroke: "var(--wg-teal)" }} strokeWidth="2" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}
