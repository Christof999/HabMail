const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const realFetch = global.fetch;
process.env.EMAILPROXY_URL = "https://proxy.example";
process.env.EMAILPROXY_KEY = "ep_test";

const { fillLargeAttachments } = require("./largeAttachments");

afterEach(() => {
  global.fetch = realFetch;
});

/** Ein Proxy, der `content` in Stücken von `sliceBytes` herausgibt. */
function slicingProxy(content, sliceBytes) {
  const calls = [];
  global.fetch = async (url) => {
    const query = new URL(String(url)).searchParams;
    calls.push(Object.fromEntries(query));
    const offset = Number(query.get("offset"));
    const slice = content.subarray(offset, offset + sliceBytes);
    const body = {
      ok: true,
      size: content.length,
      offset,
      length: slice.length,
      contentBase64: slice.toString("base64"),
      done: offset + slice.length >= content.length,
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return calls;
}

function mail(attachments) {
  return { uid: 41, attachments };
}

test("ein großer Anhang wird in Stücken geholt und wieder zusammengesetzt", async () => {
  const content = Buffer.from("Bauzaunbanner ".repeat(1000));
  // Durch drei teilbar, wie beim echten Proxy — sonst ließe sich das Base64
  // der Stücke nicht einfach aneinanderhängen.
  const calls = slicingProxy(content, 3000);
  const messages = [
    mail([
      { filename: "klein.pdf", size: 5, contentBase64: "JVBERi0=" },
      { filename: "banner.pdf", size: content.length, omitted: "too_large" },
    ]),
  ];

  assert.equal(await fillLargeAttachments("box", messages, "sent"), 1);

  const filled = messages[0].attachments[1];
  assert.equal(Buffer.from(filled.contentBase64, "base64").equals(content), true);
  assert.equal(filled.omitted, undefined);
  assert.equal(calls.length, Math.ceil(content.length / 3000));
  assert.deepEqual(
    [calls[0].mailbox, calls[0].uid, calls[0].attachment, calls[0].folder, calls[1].offset],
    ["box", "41", "1", "sent", "3000"],
  );
});

test("was über der Grenze liegt, bleibt im Postfach", async () => {
  const calls = slicingProxy(Buffer.alloc(10), 3000);
  const messages = [mail([{ filename: "film.mp4", size: 50 * 1024 * 1024, omitted: "too_large" }])];

  assert.equal(await fillLargeAttachments("box", messages), 0);
  assert.equal(calls.length, 0);
  assert.equal(messages[0].attachments[0].omitted, "too_large");
});

test("ein älterer Proxy wird erkannt, die Mail kommt trotzdem an", async () => {
  // Er kennt die Angabe nicht und antwortet mit dem gewöhnlichen Abruf.
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, messages: [] }) };
  };
  const messages = [
    mail([
      { filename: "a.pdf", size: 3_000_000, omitted: "too_large" },
      { filename: "b.pdf", size: 3_000_000, omitted: "too_large" },
    ]),
  ];

  assert.equal(await fillLargeAttachments("box", messages), 0);
  // Nach dem ersten Fehlversuch kein zweiter in diesem Lauf.
  assert.equal(calls, 1);
  assert.equal(messages[0].attachments[0].omitted, "too_large");
});
