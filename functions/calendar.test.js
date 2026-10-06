const assert = require("node:assert/strict");
const { test } = require("node:test");

const { berlinDate, berlinMidnight, berlinTime } = require("./berlinTime");
const { buildCalendar, fold } = require("./ical");
const { describeEvent, freeSlots, normalizeEvent, parseWhen, reminderOffsets, reminderText } = require("./calendar");

const iso = (ms) => new Date(ms).toISOString();

test("Berliner Uhrzeiten stimmen im Sommer, im Winter und am Tag der Umstellung", () => {
  assert.equal(iso(berlinTime("2026-07-01", 14)), "2026-07-01T12:00:00.000Z");
  assert.equal(iso(berlinTime("2026-12-01", 14)), "2026-12-01T13:00:00.000Z");
  // 25. Oktober 2026: die Uhr wird um drei auf zwei zurückgestellt.
  assert.equal(iso(berlinMidnight("2026-10-25")), "2026-10-24T22:00:00.000Z");
  assert.equal(iso(berlinTime("2026-10-25", 12)), "2026-10-25T11:00:00.000Z");
  assert.equal(iso(berlinMidnight("2026-10-26")), "2026-10-25T23:00:00.000Z");
  assert.equal(berlinDate(Date.parse("2026-10-05T22:30:00Z")), "2026-10-06");
});

test("Zeitangaben: nur Datum, Berliner Zeit ohne Zone, mit Zone", () => {
  assert.deepEqual(parseWhen("2026-10-06"), { ms: Date.parse("2026-10-05T22:00:00Z"), dateOnly: true });
  assert.equal(iso(parseWhen("2026-10-06T14:00").ms), "2026-10-06T12:00:00.000Z");
  assert.equal(iso(parseWhen("2026-10-06T14:00:00+02:00").ms), "2026-10-06T12:00:00.000Z");
  assert.equal(parseWhen("übermorgen"), null);
});

test("ein Termin ohne Ende dauert eine Stunde, ein Datum allein ist ganztägig", () => {
  const meeting = normalizeEvent({ title: "  Baustelle Müller ", start: "2026-10-06T14:00", location: "Hauptstr. 3" });
  assert.equal(meeting.title, "Baustelle Müller");
  assert.equal(meeting.allDay, false);
  assert.equal(meeting.end - meeting.start, 60 * 60_000);
  assert.equal(meeting.location, "Hauptstr. 3");

  const fair = normalizeEvent({ title: "Messe", start: "2026-10-24", end: "2026-10-25" });
  assert.equal(fair.allDay, true);
  assert.equal(iso(fair.start), "2026-10-23T22:00:00.000Z");
  // Zwei Tage, der zweite mit 25 Stunden: das Ende ist die Mitternacht danach.
  assert.equal(iso(fair.end), "2026-10-25T23:00:00.000Z");
});

test("Unsinn wird abgelehnt statt gespeichert", () => {
  assert.throws(() => normalizeEvent({ start: "2026-10-06T14:00" }), /Titel/);
  assert.throws(() => normalizeEvent({ title: "x" }), /start/);
  assert.throws(
    () => normalizeEvent({ title: "x", start: "2026-10-06T14:00", end: "2026-10-06T13:00" }),
    /Ende/,
  );
});

test("Ändern behält die Einladung, aus der der Termin stammt", () => {
  const base = normalizeEvent({ title: "Abnahme", start: "2026-10-06T14:00" });
  base.emailId = "mid_abc";
  base.icalUid = "bau-mueller-1";
  const moved = normalizeEvent({ start: "2026-10-07T09:00" }, base);
  assert.equal(moved.emailId, "mid_abc");
  assert.equal(moved.icalUid, "bau-mueller-1");
  assert.equal(moved.end - moved.start, 60 * 60_000);
});

test("Ändern verschiebt, ohne die Dauer zu verlieren", () => {
  const base = normalizeEvent({ title: "Abnahme", start: "2026-10-06T14:00", end: "2026-10-06T16:30", reminderMinutes: 30 });
  const moved = normalizeEvent({ start: "2026-10-07T09:00" }, base);
  assert.equal(moved.title, "Abnahme");
  assert.equal(moved.end - moved.start, 150 * 60_000);
  assert.equal(moved.reminderMinutes, 30);
});

test("freie Zeiten: werktags im Bürofenster, um Termine herum", () => {
  // Montag, 5. Oktober 2026.
  const from = berlinTime("2026-10-05", 0);
  const busy = [
    { start: berlinTime("2026-10-05", 9), end: berlinTime("2026-10-05", 12) },
    { start: berlinTime("2026-10-05", 13), end: berlinTime("2026-10-05", 16, 30) },
  ];
  const slots = freeSlots(busy, {
    from,
    to: berlinTime("2026-10-06", 23),
    durationMinutes: 60,
    dayStart: 8,
    dayEnd: 17,
  });

  assert.deepEqual(
    slots.map((s) => [s.start, s.freeUntil]),
    [
      [iso(berlinTime("2026-10-05", 8)), iso(berlinTime("2026-10-05", 9))],
      [iso(berlinTime("2026-10-05", 12)), iso(berlinTime("2026-10-05", 13))],
      // 16:30–17:00 ist zu kurz für eine Stunde.
      [iso(berlinTime("2026-10-06", 8)), iso(berlinTime("2026-10-06", 17))],
    ],
  );

  // Samstag und Sonntag bleiben frei von Vorschlägen.
  const weekend = freeSlots([], {
    from: berlinTime("2026-10-10", 0),
    to: berlinTime("2026-10-11", 23),
    durationMinutes: 60,
    dayStart: 8,
    dayEnd: 17,
  });
  assert.deepEqual(weekend, []);
});

test("mehrere Erinnerungen, ohne Doppelte und ohne Unsinn", () => {
  const event = normalizeEvent({
    title: "Abnahme",
    start: "2026-10-06T14:00",
    reminders: [10, 60, 10, 1440, 999999],
  });
  assert.deepEqual(event.reminders, [1440, 60, 10]);
  assert.equal(event.reminderMinutes, undefined);
  assert.deepEqual(describeEvent("e", event).reminders, [1440, 60, 10]);
});

test("eine Erinnerung bleibt der einzelne Wert, Ändern behält die Liste", () => {
  const base = normalizeEvent({ title: "Abnahme", start: "2026-10-06T14:00", reminderMinutes: 30 });
  assert.deepEqual(base.reminders, [30]);
  assert.equal(base.reminderMinutes, 30);

  const kept = normalizeEvent({ start: "2026-10-07T09:00" }, base);
  assert.deepEqual(kept.reminders, [30]);

  const replaced = normalizeEvent({ reminders: [1440, 15] }, base);
  assert.deepEqual(replaced.reminders, [1440, 15]);
  assert.equal(reminderOffsets({ reminderMinutes: 45 }).join(","), "45");
  const start = 1_000_000;
  assert.equal(reminderOffsets({ reminders: [1440, 10], start }).includes(10), true);
});

test("die Erinnerung sagt, wie lange es noch ist", () => {
  const start = berlinTime("2026-10-06", 14);
  const event = { title: "Baustelle Müller", start, end: start + 3_600_000, location: "Hauptstr. 3" };
  assert.deepEqual(reminderText(event, start - 15 * 60_000), {
    title: "In 15 Min.: Baustelle Müller",
    body: "Di., 06.10.2026, 14:00 · Hauptstr. 3",
  });
  assert.match(reminderText(event, start - 3 * 3_600_000).title, /^In 3 Std\./);
  assert.match(reminderText(event, start - 24 * 3_600_000).title, /^In 1 Tag/);
  assert.match(reminderText({ ...event, allDay: true }, start).title, /^Heute:/);
});

test("ein Agent bekommt die Zeit so, wie ein Mensch sie liest", () => {
  const start = berlinTime("2026-10-06", 14);
  const shown = describeEvent("e1", { title: "Abnahme", start, end: start + 90 * 60_000 });
  assert.equal(shown.when, "Di., 06.10.2026, 14:00 – 15:30");
  assert.equal(shown.start, "2026-10-06T12:00:00.000Z");
});

test("der Feed ist gültiges iCalendar: Zeiten in UTC, Ganztägiges als Datum, Erinnerung dabei", () => {
  const start = berlinTime("2026-10-06", 14);
  const feed = buildCalendar(
    {
      b: { title: "Messe", start: berlinMidnight("2026-10-24"), end: berlinMidnight("2026-10-26"), allDay: true },
      a: {
        title: "Abnahme; Müller, Hauptstr.",
        start,
        end: start + 3_600_000,
        location: "Hauptstr. 3",
        notes: "Schlüssel\nmitbringen",
        reminderMinutes: 15,
        reminders: [1440, 15],
        updatedAt: Date.parse("2026-10-01T08:00:00Z"),
      },
    },
    { now: Date.parse("2026-10-01T09:00:00Z") },
  );

  assert.equal(feed.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"), true);
  assert.equal(feed.endsWith("END:VCALENDAR\r\n"), true);
  // Nach Anfang sortiert, nicht nach Kennung.
  assert.equal(feed.indexOf("UID:a@habmail") < feed.indexOf("UID:b@habmail"), true);
  assert.match(feed, /DTSTART:20261006T120000Z\r\nDTEND:20261006T130000Z/);
  assert.match(feed, /SUMMARY:Abnahme\\; Müller\\, Hauptstr\./);
  assert.match(feed, /DESCRIPTION:Schlüssel\\nmitbringen/);
  assert.match(feed, /TRIGGER:-PT15M/);
  assert.match(feed, /TRIGGER:-PT1440M/);
  // Zwei ganze Tage: das Ende ist der Tag danach.
  assert.match(feed, /DTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261026/);
});

test("lange Zeilen werden nach 75 Bytes umbrochen, ohne einen Umlaut zu zerteilen", () => {
  const folded = fold(`SUMMARY:${"ä".repeat(60)}`);
  const lines = folded.split("\r\n");
  assert.equal(lines.length > 1, true);
  for (const line of lines) assert.equal(Buffer.byteLength(line, "utf8") <= 75, true);
  assert.equal(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join(""), `SUMMARY:${"ä".repeat(60)}`);
});
