/**
 * Next-Instrumentation: läuft einmal beim Serverstart. Wir starten hier den
 * Hintergrund-Poller — nur in der Node-Laufzeit (nicht Edge, nicht im Build).
 * So automatisiert sich der Datenabruf ohne separaten Databricks-Job.
 *
 * Zusätzlich die Erneuerung der Modell-Güte (skill.ts) — unabhängig vom Poller, damit auch
 * auf Databricks (Erfassung = separater Python-Job, POLL_ENABLED=0) die Gewichte beim
 * App-Start aus der über Nacht gewachsenen Historie materialisiert werden.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPoller } = await import("./lib/poller");
  startPoller();
  const { startSkillRefresher } = await import("./lib/skill");
  startSkillRefresher();
  // Gemessene Wassertemperatur (Rijkswaterstaat) — beim Start und alle 6 h.
  const { startWaterRefresher } = await import("./lib/watertemp");
  startWaterRefresher();
}
