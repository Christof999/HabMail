const assert = require("node:assert/strict");
const { test } = require("node:test");

const { describeInbox, describeSent, selectMails } = require("./mailApi");

const row = (mail, haystack = "") => ({ mail, at: Date.parse(mail.receivedAt), haystack: haystack.toLowerCase() });

test("Eingehende Mail: neue und alte Feldnamen ergeben dieselbe Ansicht", () => {
  const modern = describeInbox("a1", {
    sender: "kunde@example.de",
    senderName: "Frau Kunde",
    subject: "Angebot Bad",
    receivedAt: "2026-10-06T08:00:00.000Z",
    summary: "Bittet um ein Angebot.",
    categoryId: "anfrage",
    originalBody: "Guten Tag …",
    attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", size: 1200, dataKey: "k1" }],
  });
  assert.equal(modern.from, "kunde@example.de");
  assert.equal(modern.unread, true);
  assert.equal(modern.folderId, null);
  assert.equal(modern.hasAttachment, true);
  // Die Liste trägt weder Text noch Anhänge — die kommen erst mit read_mail.
  assert.equal(modern.body, undefined);

  const legacy = describeInbox("a2", {
    absender: "alt@example.de",
    betreff: "Rechnung 12",
    erhalten_am: "2025-01-02T10:00:00.000Z",
    zusammenfassung: "Rechnung über 100 €.",
    original_text: "Anbei …",
    userRead: true,
    ordner_id: "f1",
  });
  assert.equal(legacy.from, "alt@example.de");
  assert.equal(legacy.subject, "Rechnung 12");
  assert.equal(legacy.unread, false);
  assert.equal(legacy.folderId, "f1");
});

test("Ganze Mail: Text wird gekürzt, Anhänge nur mit Namen", () => {
  const full = describeInbox(
    "a1",
    {
      sender: "x@example.de",
      subject: "Lang",
      receivedAt: "2026-10-06T08:00:00.000Z",
      originalBody: "x".repeat(25_000),
      attachments: { 0: { filename: "a.pdf", mimeType: "application/pdf", dataBase64: "AAAA" } },
    },
    true,
  );
  assert.equal(full.body.length, 20_000);
  assert.equal(full.bodyTruncated, true);
  assert.deepEqual(full.attachments, [{ filename: "a.pdf", mimeType: "application/pdf" }]);
});

test("Gesendete Mail nennt die Empfänger", () => {
  const sent = describeSent("s1", {
    sender: "ich@example.de",
    to: [{ address: "a@example.de", name: "A" }, { address: "b@example.de" }],
    subject: "Termin",
    sentAt: "2026-10-06T09:00:00.000Z",
  });
  assert.deepEqual(sent.to, ["a@example.de", "b@example.de"]);
  assert.deepEqual(sent.cc, []);
});

test("Auswahl: Filter, Suche, Reihenfolge und Obergrenze", () => {
  const rows = [
    row({ id: "1", receivedAt: "2026-10-01T08:00:00Z", unread: false, folderId: null, categoryId: "rechnung" }, "Rechnung Müller"),
    row({ id: "2", receivedAt: "2026-10-03T08:00:00Z", unread: true, folderId: "f1", categoryId: "anfrage" }, "Anfrage Bad Müller"),
    row({ id: "3", receivedAt: "2026-10-05T08:00:00Z", unread: true, folderId: null, categoryId: "anfrage" }, "Anfrage Küche Schmidt"),
  ];
  const ids = (filter) => selectMails(rows, filter).mails.map((mail) => mail.id);

  assert.deepEqual(ids({}), ["3", "2", "1"]);
  assert.deepEqual(ids({ unreadOnly: true }), ["3", "2"]);
  assert.deepEqual(ids({ query: "müller anfrage" }), ["2"]);
  assert.deepEqual(ids({ folderId: "inbox" }), ["3", "1"]);
  assert.deepEqual(ids({ folderId: "f1" }), ["2"]);
  assert.deepEqual(ids({ categoryId: "rechnung" }), ["1"]);
  assert.deepEqual(ids({ since: "2026-10-02" }), ["3", "2"]);

  const limited = selectMails(rows, { limit: 1 });
  assert.equal(limited.total, 3);
  assert.deepEqual(limited.mails.map((mail) => mail.id), ["3"]);
});
