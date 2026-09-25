// Datum und Uhrzeit — überall dieselbe Schreibweise, in der Zeitzone der Spots:
//   „Sa 26.9."   „Sa 14:00"   „Sa 26.9., 14:00"
// Früher standen vier Varianten nebeneinander („Fr. 25.09", „Sa. 26.09.", „Do. 8.10.",
// „Fr., 25.09., 16:00"). Framework-neutral: der Server baut damit die Tages-Labels, der
// Client alles andere.

export const TZ = "Europe/Amsterdam";

const wdFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short" });
const dmFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, day: "numeric", month: "numeric" });
const hmFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const at = (sec: number) => new Date(sec * 1000);

/** „Sa" — ohne Punkt. Je nach ICU-Stand liefert Intl sonst mal „Sa", mal „Sa.". */
export const fmtWeekday = (sec: number) => wdFmt.format(at(sec)).replace(/\.$/, "");
/** „26.9." */
export const fmtDayMonth = (sec: number) => dmFmt.format(at(sec));
/** „Sa 26.9." */
export const fmtDay = (sec: number) => `${fmtWeekday(sec)} ${fmtDayMonth(sec)}`;
/** „Sa 14:00" */
export const fmtWeekdayTime = (sec: number) => `${fmtWeekday(sec)} ${hmFmt.format(at(sec))}`;
/** „Sa 26.9., 14:00" */
export const fmtDayTime = (sec: number) => `${fmtDay(sec)}, ${hmFmt.format(at(sec))}`;

/** Mittag eines Tages-Schlüssels („2026-09-26") — sicher im richtigen Kalendertag. */
export const noonOf = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
