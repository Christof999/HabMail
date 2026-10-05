/**
 * Eine Einladung lesen.
 *
 * Outlook, Google und Apple verschicken Termine als iCalendar — entweder als
 * dritte Fassung des Mailtexts (`text/calendar`) oder als angehängte
 * `invite.ics`. Der Email-Proxy liefert beides als Anhang. Hier wird daraus
 * der Termin, den die Oberfläche an der Mail anbietet.
 *
 * Gelesen wird nur, was dafür nötig ist: der erste Termin einer Datei, seine
 * Zeiten, Titel, Ort, Absender und ob er abgesagt wurde. Serientermine werden
 * erkannt und als solche gemeldet, aber nur ihr erster Tag übernommen.
 */

const { BERLIN, berlinDate, berlinMidnight } = require("./berlinTime");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Outlook nennt Zeitzonen nicht „Europe/Berlin", sondern mit den Namen aus
 * Windows. Diese hier decken ab, was in deutschen Postfächern ankommt.
 */
const WINDOWS_ZONES = {
  "w. europe standard time": BERLIN,
  "central europe standard time": BERLIN,
  "central european standard time": BERLIN,
  "romance standard time": BERLIN,
  "gmt standard time": "Europe/London",
  "e. europe standard time": "Europe/Bucharest",
  "fle standard time": "Europe/Helsinki",
  "eastern standard time": "America/New_York",
  "pacific standard time": "America/Los_Angeles",
  utc: "UTC",
};

function resolveZone(tzid) {
  const name = String(tzid ?? "").replace(/^"|"$/g, "").trim();
  if (name === "") return BERLIN;
  const known = WINDOWS_ZONES[name.toLowerCase()];
  if (known !== undefined) return known;
  try {
    // Wirft, wenn es die Zone nicht gibt.
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return name;
  } catch {
    // Eine selbst benannte Zone ohne lesbare Regeln: dann gilt die Uhr hier.
    return BERLIN;
  }
}

/** Wie weit diese Zone zu diesem Zeitpunkt vor UTC liegt, in Minuten. */
function zoneOffsetMinutes(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
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

function zoneTime(year, month, day, hour, minute, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess - zoneOffsetMinutes(guess - zoneOffsetMinutes(guess, zone) * MINUTE, zone) * MINUTE;
}

/** Fortsetzungszeilen zusammenfügen: eine Zeile, die mit Leerraum beginnt, gehört zur vorigen. */
function unfold(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

/** "DTSTART;TZID=Europe/Berlin:20261006T140000" → Name, Parameter, Wert. */
function parseLine(line) {
  // Der Doppelpunkt, der Name und Wert trennt, ist der erste außerhalb von
  // Anführungszeichen — in einem Parameter wie CN="Müller: Bau" steht auch einer.
  let quoted = false;
  let split = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      split = i;
      break;
    }
  }
  if (split === -1) return null;

  const [name, ...rawParams] = line.slice(0, split).split(";");
  const params = {};
  for (const raw of rawParams) {
    const eq = raw.indexOf("=");
    if (eq > 0) params[raw.slice(0, eq).toUpperCase()] = raw.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value: line.slice(split + 1) };
}

function unescapeText(value) {
  return String(value ?? "")
    .replace(/\\n/gi, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .trim();
}

/** @returns {{ ms: number, dateOnly: boolean } | null} */
function parseDateValue(prop) {
  if (prop === undefined) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, , utc] = match.map((part) =>
    part === undefined || part === "Z" ? part : Number(part),
  );

  if (hour === undefined) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return { ms: berlinMidnight(date), dateOnly: true };
  }
  if (utc === "Z") return { ms: Date.UTC(year, month - 1, day, hour, minute), dateOnly: false };
  return { ms: zoneTime(year, month, day, hour, minute, resolveZone(prop.params.TZID)), dateOnly: false };
}

/** "PT1H30M", "P1D", "P1W" → Millisekunden. */
function parseDuration(value) {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec(
    String(value ?? "").trim(),
  );
  if (match === null) return null;
  const [, weeks = 0, days = 0, hours = 0, minutes = 0] = match;
  const ms = (Number(weeks) * 7 + Number(days)) * DAY + (Number(hours) * 60 + Number(minutes)) * MINUTE;
  return ms > 0 ? ms : null;
}

/**
 * Der erste Termin einer iCalendar-Datei.
 *
 * @returns {null | {
 *   title: string, start: number, end: number, allDay: boolean,
 *   location?: string, organizer?: string, uid?: string,
 *   cancelled?: true, recurring?: true, source: "einladung"
 * }}
 */
function parseInvitation(text) {
  const lines = unfold(text);
  let method = "";
  let depth = 0;
  let inEvent = false;
  const props = {};

  for (const line of lines) {
    const prop = parseLine(line);
    if (prop === null) continue;

    if (prop.name === "BEGIN") {
      const what = prop.value.trim().toUpperCase();
      if (what === "VEVENT" && !inEvent && Object.keys(props).length === 0) {
        inEvent = true;
        depth = 0;
      } else if (inEvent) {
        // Ein Wecker im Termin hat eigene Felder, die nicht die des Termins sind.
        depth += 1;
      }
      continue;
    }
    if (prop.name === "END") {
      if (inEvent && depth > 0) depth -= 1;
      else if (inEvent && prop.value.trim().toUpperCase() === "VEVENT") inEvent = false;
      continue;
    }

    if (!inEvent && prop.name === "METHOD") method = prop.value.trim().toUpperCase();
    // Nur die Felder des Termins selbst — die Zeitzonen-Beschreibung davor hat
    // ebenfalls ein DTSTART, und das ist das Jahr 1601.
    if (inEvent && depth === 0 && props[prop.name] === undefined) props[prop.name] = prop;
  }

  // Eine Antwort auf eine eigene Einladung („Max hat zugesagt") ist kein
  // Termin, der einzutragen wäre.
  if (method === "REPLY" || method === "COUNTER" || method === "REFRESH") return null;

  const start = parseDateValue(props.DTSTART);
  if (start === null) return null;

  let end = parseDateValue(props.DTEND)?.ms ?? null;
  if (end === null) {
    const duration = parseDuration(props.DURATION?.value);
    end = duration === null ? null : start.ms + duration;
  }
  if (end === null || end <= start.ms) {
    // Ganztägig ohne Ende ist der eine Tag; sonst eine Stunde.
    end = start.dateOnly ? berlinMidnight(berlinDate(start.ms + 36 * 60 * MINUTE)) : start.ms + 60 * MINUTE;
  }

  const event = {
    title: unescapeText(props.SUMMARY?.value).slice(0, 200) || "Termin",
    start: start.ms,
    end,
    allDay: start.dateOnly,
    source: "einladung",
  };

  const location = unescapeText(props.LOCATION?.value).slice(0, 300);
  if (location !== "") event.location = location;

  const organizer =
    unescapeText(props.ORGANIZER?.params.CN).replace(/^"|"$/g, "") ||
    String(props.ORGANIZER?.value ?? "").replace(/^mailto:/i, "").trim();
  if (organizer !== "") event.organizer = organizer.slice(0, 200);

  const uid = String(props.UID?.value ?? "").trim();
  if (uid !== "") event.uid = uid.slice(0, 300);

  if (method === "CANCEL" || String(props.STATUS?.value ?? "").trim().toUpperCase() === "CANCELLED") {
    event.cancelled = true;
  }
  if (props.RRULE !== undefined) event.recurring = true;

  return event;
}

/** Ist dieser Anhang eine Einladung? Am Typ oder, wo der fehlt, an der Endung. */
function isCalendarAttachment(attachment) {
  const type = String(attachment?.contentType ?? attachment?.mimeType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type === "text/calendar" || type === "application/ics") return true;
  return /\.(ics|ical|ifb|vcs)$/i.test(String(attachment?.filename ?? ""));
}

/** Die erste lesbare Einladung unter den Anhängen einer abgeholten Nachricht. */
function invitationFromMessage(message) {
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    if (!isCalendarAttachment(attachment)) continue;
    const base64 = attachment.contentBase64 ?? attachment.dataBase64;
    if (typeof base64 !== "string" || base64 === "") continue;
    try {
      const event = parseInvitation(Buffer.from(base64, "base64").toString("utf8"));
      if (event !== null) return event;
    } catch {
      // Eine kaputte Datei ist kein Grund, die Mail nicht zu speichern.
    }
  }
  return null;
}

module.exports = { parseInvitation, invitationFromMessage, isCalendarAttachment };
