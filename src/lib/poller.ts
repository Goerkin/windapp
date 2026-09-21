import "server-only";

/**
 * Hintergrund-Poller: zieht die Windguru-Daten im Intervall, solange der Node-Server läuft.
 * Gestartet aus instrumentation.ts beim Serverstart. Ein globaler Marker verhindert
 * Doppelstart (Dev-HMR / mehrfaches register()).
 */

const g = globalThis as unknown as { __wgPollerStarted?: boolean };

export function startPoller() {
  if (g.__wgPollerStarted) return;
  if (process.env.POLL_ENABLED === "0") {
    console.log("[poller] deaktiviert (POLL_ENABLED=0)");
    return;
  }
  g.__wgPollerStarted = true;

  const intervalMin = Number(process.env.POLL_INTERVAL_MIN ?? 120);
  const intervalMs = Math.max(15, intervalMin) * 60 * 1000;

  const run = async (reason: string) => {
    try {
      const { ingestAll } = await import("./ingest");
      // Beim Start nur abrufen, wenn der letzte Snapshot älter als ~das halbe Intervall ist.
      const res = await ingestAll({ minAgeMin: intervalMin * 0.5 });
      console.log(`[poller] ${reason}:`, JSON.stringify(res.results));
    } catch (e) {
      console.error("[poller] Fehler:", e instanceof Error ? e.message : e);
    }
  };

  // Kurz nach dem Start ein erster Lauf, danach im Intervall.
  setTimeout(() => void run("initial"), 4000);
  setInterval(() => void run("interval"), intervalMs);
  console.log(`[poller] aktiv — Intervall ${intervalMin} min`);
}
