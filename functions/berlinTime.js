/**
 * Rechnen in Berliner Zeit.
 *
 * Die Functions laufen in UTC. Ein Termin „am 6. Oktober um 14 Uhr" oder ein
 * ganztägiger Termin meint aber die Uhr an der Wand — und die geht zweimal im
 * Jahr anders. Deshalb wird nirgends mit festen Stunden Abstand gerechnet,
 * sondern immer nachgefragt, wie weit Berlin zu genau diesem Zeitpunkt vor UTC
 * liegt.
 */

const BERLIN = "Europe/Berlin";
const MINUTE = 60_000;

/** Wie weit Berlin zu diesem Zeitpunkt vor UTC liegt, in Minuten. */
function berlinOffsetMinutes(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const value = (type) => Number(parts.find((p) => p.type === type).value);
  const local = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"));
  return Math.round((local - Math.floor(ms / MINUTE) * MINUTE) / MINUTE);
}

/** Eine Berliner Uhrzeit an einem Kalendertag ("2026-10-06") als Zeitpunkt. */
function berlinTime(date, hour = 0, minute = 0) {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Zweimal gefragt: der erste Abzug kann über eine Zeitumstellung führen.
  return guess - berlinOffsetMinutes(guess - berlinOffsetMinutes(guess) * MINUTE) * MINUTE;
}

/** Der Kalendertag in Berlin, an dem dieser Zeitpunkt liegt: "2026-10-05". */
function berlinDate(ms) {
  // en-CA schreibt Daten als JJJJ-MM-TT.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Mitternacht in Berlin zu einem Kalendertag. */
function berlinMidnight(date) {
  return berlinTime(date, 0, 0);
}

/** „Di., 06.10.2026, 14:00" — so, wie es ein Mensch liest. */
function berlinLabel(ms, allDay = false) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: BERLIN,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(new Date(ms));
}

module.exports = { BERLIN, berlinDate, berlinLabel, berlinMidnight, berlinOffsetMinutes, berlinTime };
