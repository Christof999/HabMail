const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { categorizeMessage, isConfigured } = require("./categorize");
const { berlinMidnight, berlinTime } = require("./berlinTime");

const KEYS = ["OPENAI_API_KEY", "OPENAI_MODEL", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_AI_API_KEY"];
const realFetch = global.fetch;

function setEnv(values) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

/** Fängt die eine Anfrage ab und antwortet mit `body`. */
function stubFetch(body, status = 200) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

afterEach(() => {
  global.fetch = realFetch;
  setEnv({});
});

const MESSAGE = {
  from: { name: "Muster GmbH", address: "buchhaltung@muster.de" },
  subject: "Rechnung 4711",
  text: "anbei unsere Rechnung",
  attachments: [
    { filename: "rechnung.pdf", contentType: "application/octet-stream", contentBase64: "JVBERi0=" },
    { filename: "foto.jpg", contentType: "image/jpeg", contentBase64: "/9j/4AAQ" },
    { filename: "handy.heic", contentType: "image/heic", contentBase64: "AAAA" },
  ],
};

const ANALYSIS = {
  categoryId: "rechnung",
  summary: "Muster GmbH berechnet 119,00 EUR.",
  notificationSummary: "Muster GmbH: 119,00 EUR",
  priority: "hoch",
  invoiceNumber: "4711",
  amount: 119,
  currency: "eur",
  issuedOn: "2026-10-01",
  dueOn: null,
  vendor: "Muster GmbH",
  recipient: null,
};

test("mit OPENAI_API_KEY geht die Mail an OpenAI, PDF als Datei und Bild als Bild", async () => {
  setEnv({ OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "auch-da" });
  const calls = stubFetch({
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(ANALYSIS) }] },
    ],
  });

  const result = await categorizeMessage(MESSAGE);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].body.model, "gpt-6-luna");
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.text.format.strict, true);

  const content = calls[0].body.input[0].content;
  // Aufgabe zuerst, dann PDF und JPEG — das HEIC kann OpenAI nicht lesen.
  assert.deepEqual(content.map((c) => c.type), ["input_text", "input_file", "input_image"]);
  assert.equal(content[1].file_data, "data:application/pdf;base64,JVBERi0=");
  assert.equal(content[2].image_url, "data:image/jpeg;base64,/9j/4AAQ");
  assert.match(content[0].text, /appointmentStart/);

  assert.equal(result.analyzed, true);
  assert.equal(result.attachmentsAnalyzed, 2);
  assert.equal(result.categoryId, "rechnung");
  // null aus dem strengen Schema zählt wie ein fehlendes Feld.
  assert.deepEqual(result.invoice, {
    invoiceNumber: "4711",
    amountCents: 11900,
    currency: "EUR",
    issuedOn: "2026-10-01",
    vendor: "Muster GmbH",
  });
});

test("ohne OPENAI_API_KEY bleibt es bei Gemini, samt HEIC", async () => {
  setEnv({ GEMINI_API_KEY: "g-test" });
  const calls = stubFetch({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ ...ANALYSIS, dueOn: undefined, recipient: undefined }) }] } }],
  });

  const result = await categorizeMessage(MESSAGE);

  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].headers["x-goog-api-key"], "g-test");
  assert.equal(calls[0].body.contents[0].parts.length, 4);
  assert.equal(result.analyzed, true);
  assert.equal(result.attachmentsAnalyzed, 3);
});

test("ein Fehler von OpenAI landet lesbar im Grund, die Mail in Sonstiges", async () => {
  setEnv({ OPENAI_API_KEY: "sk-test" });
  stubFetch({ error: { message: "model not found" } }, 404);

  const result = await categorizeMessage(MESSAGE);

  assert.equal(result.analyzed, false);
  assert.match(result.reason, /OpenAI fehlgeschlagen: HTTP 404/);
});

test("ein konkreter Termin wird zum Vorschlag, einer in der Vergangenheit nicht", async () => {
  setEnv({ OPENAI_API_KEY: "sk-test" });
  const message = { ...MESSAGE, date: "2026-10-05T08:00:00Z" };

  stubFetch({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              ...ANALYSIS,
              categoryId: "anfrage",
              appointmentTitle: "Abnahme Dach",
              appointmentStart: "2026-10-08T14:00",
              appointmentEnd: "2026-10-08T15:30",
              appointmentLocation: "Hauptstr. 3",
            }),
          },
        ],
      },
    ],
  });
  const suggested = await categorizeMessage(message);
  assert.equal(suggested.appointment.title, "Abnahme Dach");
  assert.equal(suggested.appointment.source, "ki");
  assert.equal(suggested.appointment.allDay, false);
  assert.equal(suggested.appointment.location, "Hauptstr. 3");
  assert.equal(suggested.appointment.start, berlinTime("2026-10-08", 14));
  assert.equal(suggested.appointment.end, berlinTime("2026-10-08", 15, 30));

  stubFetch({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              ...ANALYSIS,
              categoryId: "anfrage",
              appointmentTitle: "Alte Abnahme",
              appointmentStart: "2024-01-02",
            }),
          },
        ],
      },
    ],
  });
  const stale = await categorizeMessage(message);
  assert.equal(stale.appointment, undefined);
});

test("ein ganzer Tag reicht bis zur Mitternacht danach, ein Newsletter nennt keinen Termin", async () => {
  setEnv({ OPENAI_API_KEY: "sk-test" });
  const message = { ...MESSAGE, date: "2026-10-05T08:00:00Z" };

  stubFetch({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              ...ANALYSIS,
              categoryId: "anfrage",
              appointmentTitle: "Messe",
              appointmentStart: "2026-10-10",
              appointmentEnd: "2026-10-11",
            }),
          },
        ],
      },
    ],
  });
  const days = await categorizeMessage(message);
  assert.equal(days.appointment.allDay, true);
  assert.equal(days.appointment.start, berlinMidnight("2026-10-10"));
  assert.equal(days.appointment.end, berlinMidnight("2026-10-12"));

  stubFetch({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              ...ANALYSIS,
              categoryId: "newsletter",
              appointmentTitle: "Webinar",
              appointmentStart: "2026-10-08T14:00",
            }),
          },
        ],
      },
    ],
  });
  const newsletter = await categorizeMessage(message);
  assert.equal(newsletter.appointment, undefined);
});

test("ohne Schlüssel ist nichts eingerichtet", async () => {
  setEnv({});
  assert.equal(isConfigured(), false);
  const result = await categorizeMessage(MESSAGE);
  assert.match(result.reason, /weder OPENAI_API_KEY noch GEMINI_API_KEY/);
});
