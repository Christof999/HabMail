/**
 * Kontoauszüge einlesen — CSV, CAMT.053 (XML) und MT940.
 *
 * Warum es das gibt: der Weg über eine PSD2-Schnittstelle (GoCardless & Co.)
 * setzt eine Registrierung als Anbieter voraus, und für ein Firmenkonto auch
 * die Zustimmung der Firma. Der Auszug, den jede Bank im Online-Banking zum
 * Herunterladen anbietet, enthält dieselben Daten — ohne Anbieter, ohne
 * Vertrag, ohne Tageslimit. Damit funktioniert der Rechnungsabgleich auch
 * dann, wenn keine Bankschnittstelle verfügbar ist.
 *
 * Die Ausgabe ist bewusst identisch zu der von matching.normalizeTransaction:
 * ab da unterscheidet der Abgleich nicht mehr, woher ein Umsatz kam.
 *
 * Reine Funktionen, kein Firebase — so lässt sich das ohne Datenbank prüfen.
 */

const { createHash } = require("node:crypto");

const { normalizeName, normalizeIban } = require("./matching");

/**
 * Die Datei kommt Base64-kodiert an, das sind rund 4/3 der Bytes, und eine
 * Callable nimmt höchstens 10 MB entgegen. 5 MB lassen reichlich Luft — ein
 * Jahr Umsätze wiegt als CSV keine 300 kB.
 */
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Gemeinsame Kleinteile
// ---------------------------------------------------------------------------

/**
 * Text aus Dateibytes. Deutsche Banken liefern Auszüge mal in UTF-8, mal in
 * ISO-8859-1. Falsch geraten hieße „Grün-Bau GmbH" als Kaufmannsname —
 * deshalb: erst UTF-8, und wenn dabei Ersatzzeichen entstehen, latin1.
 */
function decodeBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  const utf8 = buffer.toString("utf8");
  return utf8.includes("�") ? buffer.toString("latin1") : utf8;
}

/**
 * "1.234,56" → 123456, "-1234.56" → -123456.
 *
 * Punkt und Komma sind je nach Bank vertauscht. Entscheidend ist das *letzte*
 * Trennzeichen: was danach kommt, sind die Nachkommastellen — es sei denn, es
 * sind genau drei Ziffern, dann war es die Tausendergruppe.
 */
function parseAmount(value) {
  let text = String(value ?? "").trim();
  if (text === "") return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^\d.,+-]/g, "");
  if (text.startsWith("-")) negative = true;
  text = text.replace(/[+-]/g, "");
  if (text === "") return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const separator = Math.max(lastComma, lastDot);

  let normalized;
  if (separator === -1) {
    normalized = text;
  } else {
    const decimals = text.length - separator - 1;
    // Drei Stellen hinter dem letzten Trenner und kein weiterer Trenner davor:
    // "1.234" ist dann Tausend, nicht ein Komma-Betrag mit drei Nachkommastellen.
    const isThousands = decimals === 3 && !/[.,]/.test(text.slice(0, separator));
    normalized = isThousands
      ? text.replace(/[.,]/g, "")
      : `${text.slice(0, separator).replace(/[.,]/g, "")}.${text.slice(separator + 1)}`;
  }

  const number = Number.parseFloat(normalized);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) * (negative ? -1 : 1);
}

/** Alles, was deutsche Banken als Datum schreiben, auf YYYY-MM-DD bringen. */
function parseDate(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "";

  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  match = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(text);
  if (match) {
    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    // Zweistellige Jahre kommen aus MT940 und CSV-Altbeständen. 70 als Grenze
    // ist die übliche Konvention und für Kontoauszüge reichlich großzügig.
    const rawYear = Number(match[3]);
    const year = match[3].length === 4 ? match[3] : String(rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear);
    return `${year}-${month}-${day}`;
  }
  return "";
}

/**
 * Ein Umsatz braucht eine Kennung, die sich beim erneuten Einlesen derselben
 * Datei wieder ergibt — sonst legt jeder Import alles noch einmal an. Aus den
 * Daten gebildet, nicht aus der Zeilennummer: Auszüge überlappen sich, und
 * derselbe Umsatz steht dann an anderer Stelle.
 */
function transactionId(account, transaction, seen) {
  const digest = createHash("sha1")
    .update(
      [
        transaction.bookingDate,
        transaction.amountCents,
        transaction.currency,
        normalizeName(transaction.counterpartyName),
        transaction.counterpartyIban,
        normalizeName(transaction.reference),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);

  const base = `imp_${account}_${digest}`;
  // Zwei wirklich gleiche Buchungen am selben Tag gibt es (zwei Abschläge über
  // denselben Betrag). Die zweite bekommt eine eigene Kennung, die beim
  // nächsten Import wieder dieselbe ist, weil die Reihenfolge im Auszug steht.
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}_${count}`;
}

/** Rohdaten einer Zeile auf die Form bringen, die der Abgleich erwartet. */
function toTransaction(raw, account, seen) {
  const amountCents = raw.amountCents;
  if (amountCents === null || amountCents === undefined || amountCents === 0) return null;
  const bookingDate = raw.bookingDate ?? "";
  if (bookingDate === "") return null;

  const transaction = {
    accountId: account,
    bookingDate,
    amountCents,
    currency: (raw.currency || "EUR").toUpperCase().slice(0, 3),
    outgoing: amountCents < 0,
    counterpartyName: String(raw.counterpartyName ?? "").trim().slice(0, 200),
    counterpartyIban: normalizeIban(raw.counterpartyIban).slice(0, 34),
    reference: String(raw.reference ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    source: "import",
  };
  transaction.id = transactionId(account, transaction, seen);
  return transaction;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Semikolon ist in Deutschland die Regel, aber eben nicht überall. */
function detectDelimiter(line) {
  const counts = [";", ",", "\t", "|"].map((candidate) => ({
    candidate,
    count: line.split(candidate).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].candidate : ";";
}

/** CSV nach RFC 4180: Anführungszeichen schützen Trenner und Zeilenumbrüche. */
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field.trim());
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows.filter((entry) => entry.some((value) => value !== ""));
}

function headerKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[äàâ]/g, "a")
    .replace(/[öòô]/g, "o")
    .replace(/[üùû]/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Spaltennamen der gängigen deutschen Banken. Die Reihenfolge zählt: der erste
 * Treffer gewinnt, deshalb steht das Genauere vor dem Allgemeineren
 * ("buchungstag" vor "datum", "ibanzahlungsbeteiligter" vor "iban").
 */
const COLUMNS = {
  bookingDate: ["buchungstag", "buchungsdatum", "belegdatum", "valutadatum", "wertstellung", "datum"],
  amount: ["betrag", "betrageur", "umsatz", "betragineur", "sollhaben"],
  currency: ["waehrung", "wahrung", "currency"],
  counterpartyName: [
    "beguenstigterzahlungspflichtiger",
    "namezahlungsbeteiligter",
    "auftraggeberempfaenger",
    "zahlungsempfaenger",
    "beguenstigter",
    "empfaenger",
    "auftraggeber",
    "beguenstigterabsender",
    "name",
  ],
  counterpartyIban: [
    "ibanzahlungsbeteiligter",
    "kontonummeriban",
    "kontonummerempfaenger",
    "ibanempfaenger",
    "iban",
    "kontonummer",
  ],
  reference: ["verwendungszweck", "vwz", "buchungstextverwendungszweck", "beschreibung"],
  bookingType: ["buchungstext", "umsatzart", "vorgang", "transaktionstyp"],
  ownAccount: ["auftragskonto", "ibanauftragskonto", "kontonummerauftragskonto", "eigenesskonto"],
  debitCredit: ["sollhabenkennzeichen", "shkennzeichen", "sollhaben"],
};

function mapHeader(header) {
  const keys = header.map(headerKey);
  const mapping = {};
  for (const [field, candidates] of Object.entries(COLUMNS)) {
    for (const candidate of candidates) {
      const index = keys.indexOf(candidate);
      if (index !== -1) {
        mapping[field] = index;
        break;
      }
    }
  }
  return mapping;
}

/**
 * Manche Banken schreiben Kontoinhaber, Zeitraum und Saldo vor die eigentliche
 * Tabelle. Die Kopfzeile ist die erste, in der sich Datum *und* Betrag finden.
 */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const mapping = mapHeader(rows[i]);
    if (mapping.bookingDate !== undefined && mapping.amount !== undefined) {
      return { index: i, mapping };
    }
  }
  return null;
}

function cell(row, index) {
  return index === undefined ? "" : (row[index] ?? "");
}

function parseCsvStatement(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const rows = parseCsv(text, detectDelimiter(firstLine));
  const header = findHeaderRow(rows);
  if (header === null) {
    throw new Error(
      "In der CSV-Datei sind keine Spalten für Buchungstag und Betrag zu finden. " +
        "Im Online-Banking bitte den Umsatz-Export als CSV, CAMT oder MT940 wählen.",
    );
  }

  const { mapping } = header;
  const seen = new Map();
  const account =
    normalizeIban(cell(rows[header.index + 1] ?? [], mapping.ownAccount)) || "import";
  const transactions = [];
  const skipped = [];

  for (let i = header.index + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const bookingDate = parseDate(cell(row, mapping.bookingDate));
    let amountCents = parseAmount(cell(row, mapping.amount));

    if (bookingDate === "" || amountCents === null) {
      // Schlusszeilen wie "Anfangssaldo" oder "Endsaldo" landen hier — die
      // sind kein Fehler, nur nichts zum Verbuchen.
      if (row.some((value) => value !== "")) skipped.push(i + 1);
      continue;
    }

    // Getrennte Spalte für Soll/Haben: der Betrag steht dann ohne Vorzeichen da.
    const mark = cell(row, mapping.debitCredit).trim().toUpperCase();
    if (mark === "S" || mark === "D") amountCents = -Math.abs(amountCents);
    else if (mark === "H" || mark === "C") amountCents = Math.abs(amountCents);

    const reference = [cell(row, mapping.reference), cell(row, mapping.bookingType)]
      .filter((part) => part !== "")
      .join(" ");

    const transaction = toTransaction(
      {
        bookingDate,
        amountCents,
        currency: cell(row, mapping.currency),
        counterpartyName: cell(row, mapping.counterpartyName),
        counterpartyIban: cell(row, mapping.counterpartyIban),
        reference,
      },
      account,
      seen,
    );
    if (transaction !== null) transactions.push(transaction);
  }

  return { format: "csv", account, transactions, skipped };
}

// ---------------------------------------------------------------------------
// CAMT.053 (XML)
// ---------------------------------------------------------------------------

/**
 * Ein sehr kleiner XML-Leser. Für CAMT reicht das: die Dateien kommen von der
 * Bank, sind wohlgeformt und brauchen weder Entitäten-Auflösung über die fünf
 * Standardnamen hinaus noch Namensräume — die Präfixe werfen wir weg.
 */
function parseXml(text) {
  const root = { name: "#root", attributes: {}, children: [], text: "" };
  const stack = [root];
  const tag = /<([!?/]?)([^\s>/!?]*)([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let match;

  while ((match = tag.exec(text)) !== null) {
    const [whole, prefix, rawName, rawAttributes, selfClose] = match;
    const parent = stack[stack.length - 1];
    parent.text += decodeEntities(text.slice(lastIndex, match.index));
    lastIndex = match.index + whole.length;

    if (prefix === "!" || prefix === "?") {
      // Kommentar, DOCTYPE oder Deklaration: überspringen. Bei Kommentaren
      // muss bis zum echten Ende gesprungen werden, sonst zerlegt ein "<" im
      // Kommentar den Rest.
      if (whole.startsWith("<!--")) {
        const end = text.indexOf("-->", match.index);
        if (end !== -1) {
          lastIndex = end + 3;
          tag.lastIndex = lastIndex;
        }
      }
      continue;
    }

    const name = rawName.includes(":") ? rawName.slice(rawName.indexOf(":") + 1) : rawName;

    if (prefix === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }

    // Nur ein Attribut wird gebraucht — die Währung an <Amt Ccy="EUR">.
    const attributes = {};
    for (const attribute of rawAttributes.matchAll(/([\w.-]+)\s*=\s*"([^"]*)"/g)) {
      attributes[attribute[1]] = decodeEntities(attribute[2]);
    }

    const node = { name, attributes, children: [], text: "" };
    parent.children.push(node);
    if (selfClose !== "/") stack.push(node);
  }

  return root;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Alle Knoten mit diesem Namen, egal wie tief. */
function findAll(node, name, into = []) {
  for (const child of node.children) {
    if (child.name === name) into.push(child);
    findAll(child, name, into);
  }
  return into;
}

/** Der erste Knoten auf dem angegebenen Pfad, sonst null. */
function child(node, ...names) {
  let current = node;
  for (const name of names) {
    if (current === null) return null;
    current = current.children.find((entry) => entry.name === name) ?? null;
  }
  return current;
}

/** Der Textinhalt des ersten Knotens mit diesem Namen, egal wie tief. */
function deepText(node, name) {
  if (node === null) return "";
  const found = findAll(node, name);
  return found.length === 0 ? "" : found[0].text.trim();
}

function parseCamtStatement(text) {
  const document = parseXml(text);
  const statements = [...findAll(document, "Stmt"), ...findAll(document, "Ntfctn")];
  if (statements.length === 0) {
    throw new Error("Die XML-Datei sieht nicht nach einem CAMT-Kontoauszug aus (kein <Stmt>).");
  }

  const seen = new Map();
  const transactions = [];
  let account = "";

  for (const statement of statements) {
    const statementIban = normalizeIban(deepText(child(statement, "Acct"), "IBAN"));
    if (account === "" && statementIban !== "") account = statementIban;

    for (const entry of findAll(statement, "Ntry")) {
      const amountNode = child(entry, "Amt");
      const magnitude = parseAmount(amountNode?.text);
      if (magnitude === null) continue;

      // CdtDbtInd trägt das Vorzeichen; im Betrag selbst steht keines.
      const debit = deepText(entry, "CdtDbtInd").toUpperCase().startsWith("DBIT");
      const amountCents = debit ? -Math.abs(magnitude) : Math.abs(magnitude);

      const bookingDate =
        parseDate(deepText(child(entry, "BookgDt"), "Dt")) ||
        parseDate(deepText(child(entry, "BookgDt"), "DtTm")) ||
        parseDate(deepText(child(entry, "ValDt"), "Dt"));

      // Die Gegenpartei steht in den Detailangaben. Bei einer Ausgabe sind wir
      // der Schuldner, also ist der Gläubiger gesucht — und umgekehrt.
      const details = child(entry, "NtryDtls", "TxDtls") ?? entry;
      const parties = child(details, "RltdPties");
      const partyNode = child(parties, debit ? "Cdtr" : "Dbtr");
      const accountNode = child(parties, debit ? "CdtrAcct" : "DbtrAcct");

      const reference = [
        ...findAll(child(details, "RmtInf") ?? details, "Ustrd").map((node) => node.text.trim()),
        deepText(child(details, "Refs"), "EndToEndId"),
        entry.children.find((node) => node.name === "AddtlNtryInf")?.text.trim() ?? "",
      ]
        .filter((part) => part !== "" && part !== "NOTPROVIDED")
        .join(" ");

      const transaction = toTransaction(
        {
          bookingDate,
          amountCents,
          currency: amountNode?.attributes?.Ccy || "EUR",
          counterpartyName: deepText(partyNode, "Nm"),
          counterpartyIban: deepText(accountNode, "IBAN"),
          reference,
        },
        statementIban || account || "import",
        seen,
      );
      if (transaction !== null) transactions.push(transaction);
    }
  }

  return { format: "camt", account: account || "import", transactions, skipped: [] };
}

// ---------------------------------------------------------------------------
// MT940 (SWIFT)
// ---------------------------------------------------------------------------

/** :86: ist in Unterfelder ?00…?63 zerlegt. */
function parseMt940Details(value) {
  if (!value.includes("?")) {
    return { name: "", iban: "", reference: value.trim() };
  }
  const fields = {};
  for (const part of value.split("?").slice(1)) {
    const code = part.slice(0, 2);
    fields[code] = (fields[code] ?? "") + part.slice(2);
  }

  const purpose = [];
  for (const code of ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "60", "61", "62", "63"]) {
    if (fields[code]) purpose.push(fields[code]);
  }
  return {
    name: `${fields["32"] ?? ""}${fields["33"] ?? ""}`.trim(),
    iban: (fields["31"] ?? "").trim(),
    // ?00 ist die Buchungsart ("DAUERAUFTRAG", "LASTSCHRIFT") — als letzter
    // Anhang nützlich, aber der Verwendungszweck gehört nach vorn.
    reference: [...purpose, fields["00"] ?? ""].filter((part) => part !== "").join(" "),
  };
}

function parseMt940Statement(text) {
  // Fortsetzungszeilen gehören zum vorherigen Feld; ein neues Feld beginnt am
  // Zeilenanfang mit ":nn:".
  const blocks = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^:\d{2}[A-Z]?:/.test(line)) blocks.push(line);
    else if (blocks.length > 0) blocks[blocks.length - 1] += line;
  }

  const seen = new Map();
  const transactions = [];
  let account = "";
  let pending = null;

  const flush = () => {
    if (pending === null) return;
    const transaction = toTransaction(pending, account || "import", seen);
    if (transaction !== null) transactions.push(transaction);
    pending = null;
  };

  for (const block of blocks) {
    const tag = block.slice(1, block.indexOf(":", 1));
    const value = block.slice(block.indexOf(":", 1) + 1);

    if (tag === "25") {
      const iban = normalizeIban(value.split("/").pop());
      if (account === "") account = iban;
      continue;
    }

    if (tag === "61") {
      flush();
      // Wertstellung(6) [Buchungstag(4)] C|D|RC|RD [Währungsart(1)] Betrag N…
      const match = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d.,]+)/.exec(value.trim());
      if (match === null) continue;

      const [, valueDate, bookingMmdd, mark, , amount] = match;
      const year = valueDate.slice(0, 2);
      const bookingDate =
        bookingMmdd === undefined
          ? parseDate(`${valueDate.slice(4, 6)}.${valueDate.slice(2, 4)}.${year}`)
          : // Der Buchungstag trägt kein Jahr. Über den Jahreswechsel hinweg
            // gehört ein Dezember-Buchungstag zum Vorjahr der Januar-Valuta.
            adjustYear(
              parseDate(`${bookingMmdd.slice(2, 4)}.${bookingMmdd.slice(0, 2)}.${year}`),
              parseDate(`${valueDate.slice(4, 6)}.${valueDate.slice(2, 4)}.${year}`),
            );

      const magnitude = parseAmount(amount);
      if (magnitude === null) continue;
      const debit = mark === "D" || mark === "RC";

      pending = {
        bookingDate,
        amountCents: debit ? -Math.abs(magnitude) : Math.abs(magnitude),
        currency: "EUR",
        counterpartyName: "",
        counterpartyIban: "",
        reference: "",
      };
      continue;
    }

    if (tag === "86" && pending !== null) {
      const details = parseMt940Details(value);
      pending.counterpartyName = details.name;
      pending.counterpartyIban = details.iban;
      pending.reference = details.reference;
      continue;
    }

    // :62F: schließt den Auszug ab — was danach kommt, ist ein neuer.
    if (tag === "62F" || tag === "62M") flush();
  }
  flush();

  if (transactions.length === 0) {
    throw new Error("In der MT940-Datei ist keine Buchung (:61:) zu finden.");
  }
  return { format: "mt940", account: account || "import", transactions, skipped: [] };
}

/** Buchungstag ohne Jahr: liegt er weit hinter der Valuta, war es das Vorjahr. */
function adjustYear(bookingDate, valueDate) {
  if (bookingDate === "" || valueDate === "") return bookingDate || valueDate;
  const booking = Date.parse(`${bookingDate}T00:00:00Z`);
  const valuta = Date.parse(`${valueDate}T00:00:00Z`);
  if (!Number.isFinite(booking) || !Number.isFinite(valuta)) return bookingDate;
  const gap = (booking - valuta) / 86_400_000;
  if (gap > 300) return `${Number(bookingDate.slice(0, 4)) - 1}${bookingDate.slice(4)}`;
  if (gap < -300) return `${Number(bookingDate.slice(0, 4)) + 1}${bookingDate.slice(4)}`;
  return bookingDate;
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------

/**
 * Einen Kontoauszug einlesen. Das Format wird am Inhalt erkannt, nicht an der
 * Dateiendung — Browser auf dem Handy hängen gern ".txt" an alles.
 *
 * @param {Buffer} buffer  Inhalt der Datei
 * @returns {{format: string, account: string, transactions: object[], skipped: number[]}}
 */
function parseStatement(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Die Datei ist leer.");
  }
  if (buffer.length > MAX_STATEMENT_BYTES) {
    throw new Error(
      `Die Datei ist zu groß (${Math.round(buffer.length / 1024 / 1024)} MB). ` +
        `Höchstens ${MAX_STATEMENT_BYTES / 1024 / 1024} MB — bitte einen kürzeren Zeitraum exportieren.`,
    );
  }

  const text = decodeBuffer(buffer);
  const head = text.slice(0, 4096);

  if (/<\?xml|<[A-Za-z]*:?Document\b|<[A-Za-z]*:?Stmt\b/.test(head)) {
    return parseCamtStatement(text);
  }
  if (/^\s*(?::\d{2}[A-Z]?:|\{[1-4]:)/m.test(head)) {
    return parseMt940Statement(text);
  }
  return parseCsvStatement(text);
}

module.exports = {
  parseStatement,
  parseAmount,
  parseDate,
  decodeBuffer,
  MAX_STATEMENT_BYTES,
};
