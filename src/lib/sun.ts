// Sonnenauf-/-untergang je Tag aus Koordinaten (NOAA-Sonnengleichung, ±1–2 min genau).
// Windguru liefert Sonnenzeiten nur für HEUTE; für den Tageskennwert und die Fahrfenster
// brauchen wir sie für jeden der ~10 Prognosetage. Framework-neutral (Client + Server).

const RAD = Math.PI / 180;

/**
 * Sonnenaufgang/-untergang (Unix-Sekunden) für den Kalendertag `dayKey` ("YYYY-MM-DD").
 * Polartag/-nacht kommen in NL nicht vor; zur Sicherheit fällt die Rechnung dann auf
 * 06–20 Uhr UTC zurück.
 */
export function sunTimes(lat: number, lon: number, dayKey: string): { rise: number; set: number } {
  const [y, m, d] = dayKey.split("-").map(Number);
  const noonUtcMs = Date.UTC(y, m - 1, d, 12);
  const jDate = noonUtcMs / 86400000 + 2440587.5;
  const n = Math.round(jDate - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  const toUnix = (j: number) => Math.round((j - 2440587.5) * 86400);
  if (cosW < -1 || cosW > 1) {
    const base = Date.UTC(y, m - 1, d) / 1000;
    return { rise: base + 6 * 3600, set: base + 20 * 3600 };
  }
  const w = Math.acos(cosW) / RAD;
  return { rise: toUnix(jTransit - w / 360), set: toUnix(jTransit + w / 360) };
}

/**
 * Zählt die Stunde `t` (Stundenwert der Prognose) als fahrbares Tageslicht? Ab einer halben
 * Stunde vor Sonnenaufgang bis eine halbe Stunde vor Sonnenuntergang (danach lohnt kein
 * Aufbau mehr).
 */
export function isDaylight(t: number, sun: { rise: number; set: number }): boolean {
  return t >= sun.rise - 1800 && t <= sun.set - 1800;
}
