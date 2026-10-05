/**
 * Der Kalender — das, was davon auf dem Server laufen muss.
 *
 * Termine liegen je Person unter `users/<uid>/calendar/events`. Anlegen und
 * ändern kann sie der Browser selbst; hier sitzt nur, was ohne offenes Fenster
 * passieren muss oder von außen kommt:
 *
 *   calendarReminders  jede Minute: fällige Erinnerungen als Push verschicken
 *   calendarFeed       der Abo-Link für Apple Kalender, Google Kalender, Outlook
 *   calendarApi        Termine lesen und anlegen für KI-Agenten (siehe AGENTS.md)
 */

const { createHash, timingSafeEqual } = require("node:crypto");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const {
  BERLIN,
  berlinDate,
  berlinLabel,
  berlinMidnight,
  berlinTime,
  parseWhen,
} = require("./berlinTime");
const { buildCalendar } = require("./ical");
const {
  CALENDAR_REMINDERS_PATH,
  userCalendarEventsPath,
  userCalendarFeedTokenPath,
} = require("./paths");
const { sendToUser } = require("./push");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const MAX_TITLE = 200;
const MAX_LOCATION = 300;
const MAX_NOTES = 4000;
/** Vier Wochen vorher bis einen Tag danach (ganztägig: „um 8 Uhr am selben Tag"). */
const MIN_REMINDER_MINUTES = -DAY / MINUTE;
const MAX_REMINDER_MINUTES = (28 * DAY) / MINUTE;

/* ----------------------------------------------------------------- Zeiten */

/** Mitternacht nach dem Berliner Tag, in dem dieser Zeitpunkt liegt. */
function midnightAfter(ms) {
  // Über den Mittag zum nächsten Tag: ein Tag hat bei der Zeitumstellung
  // 23 oder 25 Stunden, plus 24 landete dann daneben.
  return berlinMidnight(berlinDate(berlinTime(berlinDate(ms), 12) + DAY));
}

/* ---------------------------------------------------------------- Termine */

class CalendarInputError extends Error {}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Aus der Angabe eines Agenten einen Termin machen, wie er in der Datenbank
 * steht. `base` ist der bestehende Termin beim Ändern.
 */
function normalizeEvent(input, base = null) {
  const title = input.title === undefined && base ? base.title : text(input.title, MAX_TITLE);
  if (title === "") throw new CalendarInputError("Der Termin braucht einen Titel.");

  const startIn = input.start === undefined ? null : parseWhen(input.start);
  if (input.start !== undefined && startIn === null) {
    throw new CalendarInputError('"start" ist keine lesbare Zeitangabe.');
  }
  if (startIn === null && base === null) throw new CalendarInputError('"start" fehlt.');

  const allDay =
    typeof input.allDay === "boolean"
      ? input.allDay
      : startIn !== null
        ? startIn.dateOnly
        : base.allDay === true;

  let start = startIn === null ? base.start : startIn.ms;
  if (allDay) start = berlinMidnight(berlinDate(start));

  let end;
  if (input.end !== undefined) {
    const endIn = parseWhen(input.end);
    if (endIn === null) throw new CalendarInputError('"end" ist keine lesbare Zeitangabe.');
    // Ganztägig nennt man den letzten Tag; gespeichert wird die Mitternacht danach.
    end = allDay ? midnightAfter(endIn.ms) : endIn.ms;
  } else if (base !== null && startIn === null) {
    end = base.end;
  } else if (base !== null) {
    end = start + (base.end - base.start);
  } else {
    end = allDay ? midnightAfter(start) : start + 60 * MINUTE;
  }
  if (end <= start) throw new CalendarInputError("Das Ende liegt nicht nach dem Anfang.");

  const event = { title, start, end, allDay };

  const location = input.location === undefined ? (base?.location ?? "") : text(input.location, MAX_LOCATION);
  if (location !== "") event.location = location;
  const notes = input.notes === undefined ? (base?.notes ?? "") : text(input.notes, MAX_NOTES);
  if (notes !== "") event.notes = notes;

  const reminder = input.reminderMinutes === undefined ? base?.reminderMinutes : input.reminderMinutes;
  if (typeof reminder === "number" && Number.isFinite(reminder)) {
    event.reminderMinutes = Math.min(
      MAX_REMINDER_MINUTES,
      Math.max(MIN_REMINDER_MINUTES, Math.round(reminder)),
    );
  }

  if (base?.emailId) event.emailId = base.emailId;
  if (typeof input.emailId === "string" && input.emailId !== "") event.emailId = input.emailId.slice(0, 80);
  // Die Einladungs-UID bleibt beim Ändern erhalten, sonst träfe die nächste
  // Mail zur selben Einladung den Termin nicht mehr.
  if (typeof base?.icalUid === "string" && base.icalUid !== "") event.icalUid = base.icalUid;

  return event;
}

/** Wie ein Termin einem Agenten gezeigt wird — mit lesbarer Zeit dazu. */
function describeEvent(id, event) {
  return {
    id,
    title: event.title,
    start: new Date(event.start).toISOString(),
    end: new Date(event.end).toISOString(),
    allDay: event.allDay === true,
    when: event.allDay
      ? berlinLabel(event.start, true)
      : `${berlinLabel(event.start)} – ${berlinLabel(event.end).slice(-5)}`,
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
    ...(typeof event.reminderMinutes === "number" ? { reminderMinutes: event.reminderMinutes } : {}),
  };
}

/** Termine, die den Zeitraum berühren, nach Anfang sortiert. */
async function eventsBetween(uid, from, to) {
  // Nach dem Anfang gefragt, und zwar etwas früher: ein mehrtägiger Termin,
  // der vor dem Zeitraum beginnt, ragt sonst unbemerkt hinein.
  const snapshot = await admin
    .database()
    .ref(userCalendarEventsPath(uid))
    .orderByChild("start")
    .startAt(from - 31 * DAY)
    .endAt(to)
    .get();
  return Object.entries(snapshot.val() ?? {})
    .filter(([, event]) => event && event.end > from && event.start < to)
    .sort(([, a], [, b]) => a.start - b.start);
}

/* ----------------------------------------------------------- Erinnerungen */

function reminderKey(uid, eventId) {
  return `${uid}_${eventId}`;
}

/**
 * Die Erinnerung zu einem Termin in die Warteschlange legen oder herausnehmen.
 * Legt der Browser einen Termin an, tut er dasselbe selbst (`src/calendar.ts`).
 */
async function syncReminder(uid, eventId, event) {
  const ref = admin.database().ref(`${CALENDAR_REMINDERS_PATH}/${reminderKey(uid, eventId)}`);
  if (event === null || typeof event.reminderMinutes !== "number") {
    await ref.remove();
    return;
  }
  const at = event.start - event.reminderMinutes * MINUTE;
  if (at <= Date.now()) {
    await ref.remove();
    return;
  }
  await ref.set({ uid, eventId, at });
}

function reminderText(event, now) {
  const minutes = Math.round((event.start - now) / MINUTE);
  const lead =
    event.allDay === true
      ? "Heute"
      : minutes <= 1
        ? "Jetzt"
        : minutes < 90
          ? `In ${minutes} Min.`
          : minutes < 36 * 60
            ? `In ${Math.round(minutes / 60)} Std.`
            : `In ${Math.round(minutes / 1440)} Tagen`;
  return {
    title: `${lead}: ${event.title}`.slice(0, 120),
    body: [berlinLabel(event.start, event.allDay === true), event.location].filter(Boolean).join(" · "),
  };
}

/** Was länger als das überfällig ist, wird nicht mehr gemeldet — etwa nach einem Ausfall. */
const STALE_AFTER_MS = 2 * 60 * MINUTE;

/** Fällige Erinnerungen verschicken. Gibt zurück, was dabei herauskam. */
async function sendDueReminders(now = Date.now()) {
  const db = admin.database();
  const snapshot = await db
    .ref(CALENDAR_REMINDERS_PATH)
    .orderByChild("at")
    .endAt(now)
    .limitToFirst(100)
    .get();

  const report = { due: 0, sent: 0, dropped: 0 };
  for (const [key, entry] of Object.entries(snapshot.val() ?? {})) {
    report.due += 1;
    // Erst herausnehmen, dann schicken: lieber eine Erinnerung zu wenig als
    // dieselbe jede Minute wieder, falls das Verschicken hängt.
    await db.ref(`${CALENDAR_REMINDERS_PATH}/${key}`).remove();

    const uid = typeof entry?.uid === "string" ? entry.uid : "";
    const eventId = typeof entry?.eventId === "string" ? entry.eventId : "";
    const event =
      uid === "" || eventId === ""
        ? null
        : (await db.ref(`${userCalendarEventsPath(uid)}/${eventId}`).get()).val();

    // Der Termin kann inzwischen gelöscht oder verschoben sein. Gilt die
    // Erinnerung nicht mehr für das, was jetzt dasteht, bleibt sie aus.
    const stillMeant =
      event !== null &&
      typeof event.reminderMinutes === "number" &&
      Math.abs(event.start - event.reminderMinutes * MINUTE - entry.at) < MINUTE;
    if (!stillMeant || now - entry.at > STALE_AFTER_MS) {
      report.dropped += 1;
      continue;
    }

    try {
      await sendToUser(uid, { ...reminderText(event, now), tag: `habmail-termin-${eventId}` });
      report.sent += 1;
    } catch (error) {
      console.warn(`Erinnerung nicht verschickt (${uid}/${eventId}):`, error);
    }
  }
  return report;
}

const calendarReminders = onSchedule(
  { schedule: "every 1 minutes", timeZone: BERLIN, timeoutSeconds: 60, maxInstances: 1 },
  async () => {
    const report = await sendDueReminders();
    if (report.due > 0) console.log("Erinnerungen:", JSON.stringify(report));
  },
);

/* ----------------------------------------------------------------- Abo-Link */

function sameToken(expected, given) {
  const a = createHash("sha256").update(String(expected)).digest();
  const b = createHash("sha256").update(String(given)).digest();
  return timingSafeEqual(a, b);
}

/** Der Feed reicht ein Vierteljahr zurück — Vergangenes davor braucht kein Telefon. */
const FEED_LOOKBACK_MS = 92 * DAY;

/**
 * Der Kalender als abonnierbarer Feed.
 *
 * Kalenderprogramme können sich nicht anmelden; sie rufen nur eine Adresse ab.
 * Deshalb steckt der Zugang in der Adresse selbst: ein langes Zufallswort, das
 * die Person in HabMail erzeugt und jederzeit ersetzen kann.
 */
const calendarFeed = onRequest({ cors: false, invoker: "public" }, async (req, res) => {
  const uid = typeof req.query.u === "string" ? req.query.u : "";
  const token = typeof req.query.t === "string" ? req.query.t : "";
  // Was in einen Datenbankpfad geht, darf nichts enthalten, das dort Bedeutung hat.
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(uid) || token.length < 20) {
    res.status(404).send("Nicht gefunden.");
    return;
  }

  const db = admin.database();
  const expected = (await db.ref(userCalendarFeedTokenPath(uid)).get()).val();
  if (typeof expected !== "string" || expected.length < 20 || !sameToken(expected, token)) {
    res.status(404).send("Nicht gefunden.");
    return;
  }

  const snapshot = await db
    .ref(userCalendarEventsPath(uid))
    .orderByChild("start")
    .startAt(Date.now() - FEED_LOOKBACK_MS)
    .get();

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Cache-Control", "private, max-age=300");
  res.status(200).send(buildCalendar(snapshot.val() ?? {}, { name: "HabMail" }));
});

/* ------------------------------------------------------------ Für Agenten */

/**
 * Das Kennwort zwischen /api/mcp (Vercel) und dieser Function.
 *
 * Abgeleitet aus dem Schlüssel des Email-Proxys, den beide Seiten ohnehin
 * kennen — so braucht es kein weiteres Geheimnis, das an zwei Stellen
 * hinterlegt und gepflegt werden will. Über die Leitung geht nur die
 * Ableitung, nie der Schlüssel selbst.
 */
function agentSecret() {
  const key = (process.env.EMAILPROXY_KEY || "").trim();
  return key === "" ? "" : createHash("sha256").update(`habmail-calendar-agent:${key}`).digest("hex");
}

const DEFAULT_DAY_START = 8;
const DEFAULT_DAY_END = 17;

/** Freie Zeiten an Werktagen, je Lücke der frühestmögliche Beginn. */
function freeSlots(busy, { from, to, durationMinutes, dayStart, dayEnd, limit = 20 }) {
  const duration = durationMinutes * MINUTE;
  const slots = [];

  for (let day = berlinDate(from); slots.length < limit; ) {
    const open = Math.max(from, berlinTime(day, dayStart));
    const close = Math.min(to, berlinTime(day, dayEnd));
    const weekday = new Date(berlinTime(day, 12)).getUTCDay();

    if (weekday !== 0 && weekday !== 6 && close - open >= duration) {
      let cursor = open;
      const taken = busy.filter((b) => b.end > open && b.start < close).sort((a, b) => a.start - b.start);
      for (const block of [...taken, { start: close, end: close }]) {
        if (block.start - cursor >= duration && slots.length < limit) {
          slots.push({ start: cursor, end: block.start });
        }
        cursor = Math.max(cursor, block.end);
      }
    }

    const next = berlinDate(berlinTime(day, 12) + DAY);
    if (berlinTime(next, 0) >= to) break;
    day = next;
  }

  return slots.map((slot) => ({
    start: new Date(slot.start).toISOString(),
    freeUntil: new Date(slot.end).toISOString(),
    when: `${berlinLabel(slot.start)} – ${berlinLabel(slot.end).slice(-5)}`,
  }));
}

async function handleAgent(uid, body) {
  const db = admin.database();
  const eventsRef = db.ref(userCalendarEventsPath(uid));
  const now = Date.now();

  switch (body.action) {
    case "list": {
      const from = parseWhen(body.from)?.ms ?? now;
      const to = parseWhen(body.to)?.ms ?? from + 14 * DAY;
      const events = await eventsBetween(uid, from, to);
      return { events: events.slice(0, 200).map(([id, event]) => describeEvent(id, event)) };
    }
    case "free": {
      const from = Math.max(now, parseWhen(body.from)?.ms ?? now);
      const to = parseWhen(body.to)?.ms ?? from + 7 * DAY;
      const durationMinutes = Math.min(480, Math.max(15, Number(body.durationMinutes) || 60));
      const busy = (await eventsBetween(uid, from, to)).map(([, event]) => ({
        start: event.start,
        end: event.end,
      }));
      return {
        durationMinutes,
        slots: freeSlots(busy, {
          from,
          to: Math.min(to, from + 62 * DAY),
          durationMinutes,
          dayStart: Number.isInteger(body.dayStart) ? body.dayStart : DEFAULT_DAY_START,
          dayEnd: Number.isInteger(body.dayEnd) ? body.dayEnd : DEFAULT_DAY_END,
        }),
      };
    }
    case "create": {
      const event = { ...normalizeEvent(body.event ?? {}), createdAt: now, updatedAt: now, source: "agent" };
      const overlaps = (await eventsBetween(uid, event.start, event.end)).map(([id, other]) =>
        describeEvent(id, other),
      );
      if (body.dryRun === true) {
        return { dryRun: true, event: describeEvent("(neu)", event), overlaps };
      }
      const ref = eventsRef.push();
      await ref.set(event);
      await syncReminder(uid, ref.key, event);
      return { event: describeEvent(ref.key, event), overlaps };
    }
    case "update": {
      const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.id) ? body.id : "";
      const current = id === "" ? null : (await eventsRef.child(id).get()).val();
      if (current === null) throw new CalendarInputError("Diesen Termin gibt es nicht.");
      const event = {
        ...normalizeEvent(body.event ?? {}, current),
        createdAt: current.createdAt ?? now,
        updatedAt: now,
        source: current.source ?? "agent",
      };
      await eventsRef.child(id).set(event);
      await syncReminder(uid, id, event);
      return { event: describeEvent(id, event) };
    }
    case "delete": {
      const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.id) ? body.id : "";
      if (id === "") throw new CalendarInputError("Diesen Termin gibt es nicht.");
      await eventsRef.child(id).remove();
      await syncReminder(uid, id, null);
      return { deleted: id };
    }
    default:
      throw new CalendarInputError('Unbekannte "action". Möglich: list, free, create, update, delete.');
  }
}

const calendarApi = onRequest({ cors: false, invoker: "public" }, async (req, res) => {
  const expected = agentSecret();
  const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (expected === "" || given === "" || !sameToken(expected, given)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const uid = typeof body.uid === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(body.uid) ? body.uid : "";
  if (uid === "") {
    res.status(400).json({ error: "bad_request", hint: "uid fehlt." });
    return;
  }

  try {
    res.status(200).json({ ok: true, ...(await handleAgent(uid, body)) });
  } catch (error) {
    if (error instanceof CalendarInputError) {
      res.status(400).json({ error: "bad_request", hint: error.message });
      return;
    }
    console.error("calendarApi:", error);
    res.status(500).json({ error: "internal", hint: "Der Kalender ließ sich nicht lesen." });
  }
});

module.exports = {
  calendarReminders,
  calendarFeed,
  calendarApi,
  // Für Tests.
  describeEvent,
  freeSlots,
  normalizeEvent,
  parseWhen,
  reminderText,
  sendDueReminders,
  agentSecret,
};
