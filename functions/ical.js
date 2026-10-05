/**
 * Termine als iCalendar (RFC 5545) — das Format, das Apple Kalender, Google
 * Kalender und Outlook abonnieren können.
 *
 * Bewusst von Hand und ohne Bibliothek: gebraucht wird ein Bruchteil des
 * Formats, und die Functions sollen ein kleines Deploy-Paket bleiben.
 */

const { BERLIN, berlinDate } = require("./berlinTime");

/** Kommas, Semikolons, Backslashes und Zeilenumbrüche haben im Format eine Bedeutung. */
function escapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Zeilen dürfen höchstens 75 Bytes lang sein; längere werden umbrochen und mit
 * einem Leerzeichen fortgesetzt. Gezählt wird in Bytes, nicht in Zeichen — ein
 * Umlaut zählt doppelt und darf nicht in der Mitte zerteilt werden.
 */
function fold(line) {
  const parts = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** 20261005T093000Z */
function utcStamp(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function nextDay(date) {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function eventLines(id, event, now) {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(id)}@habmail`,
    `DTSTAMP:${utcStamp(event.updatedAt ?? event.createdAt ?? now)}`,
  ];

  if (event.allDay === true) {
    // Ganztägig heißt: ein Datum ohne Uhrzeit, und das Ende ist der Tag
    // danach — das Format zählt das Ende nicht mehr mit.
    const first = berlinDate(event.start);
    const last = berlinDate(Math.max(event.start, event.end - 1));
    lines.push(`DTSTART;VALUE=DATE:${first.replace(/-/g, "")}`);
    lines.push(`DTEND;VALUE=DATE:${nextDay(last).replace(/-/g, "")}`);
  } else {
    lines.push(`DTSTART:${utcStamp(event.start)}`);
    lines.push(`DTEND:${utcStamp(Math.max(event.end, event.start))}`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);

  // Die Erinnerung geht mit: wer den Kalender abonniert, wird auch dort
  // erinnert, wo HabMail selbst keinen Push schicken kann.
  if (typeof event.reminderMinutes === "number" && event.reminderMinutes >= 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(event.title)}`,
      `TRIGGER:-PT${Math.round(event.reminderMinutes)}M`,
      "END:VALARM",
    );
  }

  lines.push("END:VEVENT");
  return lines;
}

/**
 * @param {Record<string, object>} events Termine nach ihrer Kennung.
 * @param {{ name?: string, now?: number }} [options]
 */
function buildCalendar(events, { name = "HabMail", now = Date.now() } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HabMail//Kalender//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${BERLIN}`,
    // Wie oft ein Abonnent nachsehen soll. Apple hält sich daran, Google nicht.
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];

  const sorted = Object.entries(events ?? {})
    .filter(([, event]) => event && typeof event.start === "number" && typeof event.end === "number")
    .sort(([, a], [, b]) => a.start - b.start);
  for (const [id, event] of sorted) lines.push(...eventLines(id, event, now));

  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

module.exports = { buildCalendar, escapeText, fold };
