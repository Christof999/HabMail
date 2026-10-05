const assert = require("node:assert/strict");
const { test } = require("node:test");

const { berlinMidnight, berlinTime } = require("./berlinTime");
const { invitationFromMessage, isCalendarAttachment, parseInvitation } = require("./icalParse");

const iso = (ms) => new Date(ms).toISOString();

test("Einladung mit Windows-Zeitzone, Ort und Absender", () => {
  const event = parseInvitation(`BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VTIMEZONE
TZID:W. Europe Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:bau-mueller-1
DTSTART;TZID=W. Europe Standard Time:20261006T140000
DTEND;TZID=W. Europe Standard Time:20261006T153000
SUMMARY:Abnahme Dach
LOCATION:Hauptstr. 3
ORGANIZER;CN="Müller: Bau":mailto:mueller@firma.de
BEGIN:VALARM
TRIGGER:-PT30M
DESCRIPTION:nicht der Titel
END:VALARM
END:VEVENT
END:VCALENDAR`);

  assert.equal(event.title, "Abnahme Dach");
  assert.equal(iso(event.start), iso(berlinTime("2026-10-06", 14)));
  assert.equal(iso(event.end), iso(berlinTime("2026-10-06", 15, 30)));
  assert.equal(event.allDay, false);
  assert.equal(event.location, "Hauptstr. 3");
  assert.equal(event.organizer, "Müller: Bau");
  assert.equal(event.uid, "bau-mueller-1");
  assert.equal(event.source, "einladung");
  assert.equal(event.cancelled, undefined);
});

test("Zeiten in UTC und eine Dauer statt eines Endes", () => {
  const event = parseInvitation(`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20261201T130000Z
DURATION:PT90M
SUMMARY:Telefonat
END:VEVENT
END:VCALENDAR`);

  assert.equal(iso(event.start), iso(berlinTime("2026-12-01", 14)));
  assert.equal(event.end - event.start, 90 * 60_000);
});

test("ganztägig über die Zeitumstellung, das Ende ist der Tag danach", () => {
  const event = parseInvitation(`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261024
DTEND;VALUE=DATE:20261026
SUMMARY:Messe
RRULE:FREQ=YEARLY
END:VEVENT
END:VCALENDAR`);

  assert.equal(event.allDay, true);
  assert.equal(event.recurring, true);
  assert.equal(iso(event.start), iso(berlinMidnight("2026-10-24")));
  assert.equal(iso(event.end), iso(berlinMidnight("2026-10-26")));
});

test("eine Antwort und eine Absage", () => {
  assert.equal(
    parseInvitation(`BEGIN:VCALENDAR
METHOD:REPLY
BEGIN:VEVENT
DTSTART:20261006T140000Z
SUMMARY:Zusage
END:VEVENT
END:VCALENDAR`),
    null,
  );

  const cancelled = parseInvitation(`BEGIN:VCALENDAR
METHOD:CANCEL
BEGIN:VEVENT
DTSTART:20261006T120000Z
DTEND:20261006T130000Z
SUMMARY:Abnahme
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.title, "Abnahme");
});

test("Fortsetzungszeilen gehören zum Titel", () => {
  // Das erste Leerzeichen nach dem Umbruch ist die Faltung und fällt weg.
  // Das zweite ist das Leerzeichen im Titel.
  const event = parseInvitation("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261006T120000Z\r\nSUMMARY:Abnahme\r\n  Dach, Fam. Müller\r\nEND:VEVENT\r\nEND:VCALENDAR");
  assert.equal(event.title, "Abnahme Dach, Fam. Müller");
});

test("der Proxy liefert die Einladung als Anhang, mit und ohne Dateinamen", () => {
  const ics = Buffer.from(`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20261006T120000Z
SUMMARY:Besichtigung
END:VEVENT
END:VCALENDAR`).toString("base64");

  assert.equal(isCalendarAttachment({ contentType: "text/calendar", filename: "anhang" }), true);
  assert.equal(isCalendarAttachment({ filename: "invite.ics", contentType: "application/octet-stream" }), true);
  assert.equal(isCalendarAttachment({ filename: "rechnung.pdf", contentType: "application/pdf" }), false);

  const event = invitationFromMessage({
    attachments: [
      { filename: "rechnung.pdf", contentType: "application/pdf", contentBase64: "JVBERi0=" },
      { filename: "anhang", contentType: "text/calendar; method=REQUEST", contentBase64: ics },
    ],
  });
  assert.equal(event.title, "Besichtigung");
  assert.equal(event.end - event.start, 60 * 60_000);
});
