import Link from "next/link";
import { loadDashboard } from "@/lib/data";
import AnalysisView from "@/components/AnalysisView";
import type { SpotPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Analyse auf eigener Route statt als dritter Tab im Spot-Panel.
 *
 * Grund: Modellvergleich und Güte-Rückschau sind Nachschlage-Ansichten, keine Antwort auf
 * „wann kann ich fahren?". Im Spot-Panel lagen sie vier Klick-Ebenen tief (Übersicht → Spot →
 * Tab → Segment → Aufklapper). Hier sind sie eine Ebene tief und direkt verlinkbar.
 */
export default async function AnalysePage() {
  let spots: SpotPayload[] = [];
  let error: string | null = null;
  try {
    spots = (await loadDashboard()).filter((s) => !s.empty);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div>
          <h1 className="font-display text-2xl font-700 text-ink sm:text-3xl">Analyse</h1>
          <p className="text-xs text-muted">
            Welches Modell taugt an welchem Spot — und wie gut war der Konsens wirklich?
          </p>
        </div>
        <Link href="/" className="chip hover:border-accent">
          ← Cockpit
        </Link>
      </header>

      {error && (
        <div className="panel-flat border-l-2 p-4 text-sm" style={{ borderLeftColor: "var(--wg-red)" }}>
          <span className="text-body">Fehler beim Laden der Daten: {error}</span>
        </div>
      )}

      {!error && !spots.length && (
        <div className="panel p-8 text-center text-sm text-muted">
          Noch keine ausgewerteten Daten. Der Datenerfassungs-Job und der Lern-Job müssen
          mindestens einmal gelaufen sein.
        </div>
      )}

      {spots.length > 0 && <AnalysisView spots={spots} />}
    </div>
  );
}
