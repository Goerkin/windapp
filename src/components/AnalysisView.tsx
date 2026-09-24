"use client";
import { useState } from "react";
import type { SpotPayload } from "@/lib/types";
import type { WindUnit } from "@/lib/units";
import ModelPanel from "./ModelPanel";
import AccuracyPanel from "./AccuracyPanel";
import { relTime } from "./ui";

/** Spot- und Themenwahl für die Analyse-Route. Reine Auswahl — die Panels sind unverändert. */
export default function AnalysisView({ spots }: { spots: SpotPayload[] }) {
  const [spotId, setSpotId] = useState<number>(spots[0].id);
  const [unit, setUnit] = useState<WindUnit>("kn");
  const [view, setView] = useState<"models" | "accuracy">("models");
  const spot = spots.find((s) => s.id === spotId) ?? spots[0];

  // Wächter über die Datenbasis: stumme Messstationen machen jede Güte-Zahl wertlos, also
  // stehen sie hier oben und nicht in einem Job-Log, das niemand liest.
  const silent = spot.stations.filter((s) => s.ageMin == null || s.ageMin > 6 * 60);
  const learnedAt = spot.method?.fittedAt ?? null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="seg" role="group" aria-label="Spot">
          {spots.map((s) => (
            <button key={s.id} data-active={s.id === spotId} onClick={() => setSpotId(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Ansicht">
          <button data-active={view === "models"} onClick={() => setView("models")}>
            Modelle
          </button>
          <button data-active={view === "accuracy"} onClick={() => setView("accuracy")}>
            Genauigkeit
          </button>
        </div>
        <div className="seg" role="group" aria-label="Einheit">
          {(["kn", "ms"] as WindUnit[]).map((u) => (
            <button key={u} data-active={unit === u} onClick={() => setUnit(u)}>
              {u === "kn" ? "kn" : "m/s"}
            </button>
          ))}
        </div>
      </div>

      {(silent.length > 0 || learnedAt) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          {silent.map((s) => (
            <span key={s.id} style={{ color: "var(--wg-amber)" }}>
              ⚠ Messstation „{s.name}" liefert nichts
              {s.obsTime ? ` (letzter Wert ${relTime(s.obsTime)})` : ""} — die Güte-Zahlen
              altern entsprechend.
            </span>
          ))}
          {learnedAt && (
            <span className="text-faint">
              Modell gelernt {relTime(new Date(learnedAt * 1000).toISOString())}
            </span>
          )}
        </div>
      )}

      <section className="panel p-4 sm:p-5">
        {view === "models" ? <ModelPanel spot={spot} unit={unit} /> : <AccuracyPanel spot={spot} unit={unit} />}
      </section>
    </>
  );
}
