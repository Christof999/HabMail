#!/usr/bin/env node
/**
 * Bestand auf die Benutzertrennung umstellen.
 *
 * Früher lagen Mails und Ordner flach an der Wurzel der Datenbank und jeder
 * Angemeldete konnte alles lesen. Seit es mehrere Benutzer gibt, hängt alles
 * unter `users/<uid>/`. Dieses Skript zieht die vorhandenen Daten dorthin um.
 *
 * Vorbereitung:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/pfad/zum/service-account.json
 *   export FIREBASE_DATABASE_URL=https://<projekt>-default-rtdb.europe-west1.firebasedatabase.app
 *
 * Erst ansehen, dann umziehen:
 *   node functions/scripts/migrate-to-users.mjs --email du@example.com --dry-run
 *   node functions/scripts/migrate-to-users.mjs --email du@example.com
 *
 * Das Skript kopiert und löscht die alten Knoten erst danach — und nur, wenn
 * das Kopieren durchgelaufen ist. Ein Abbruch mittendrin lässt den alten
 * Stand also unangetastet. Mit --keep-source bleibt er ohnehin liegen.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const DRY_RUN = flag("dry-run");
const KEEP_SOURCE = flag("keep-source");
const EMAIL = value("email");
const UID_ARG = value("uid");
/** Wo die Mails bisher lagen. Leer = direkt an der Wurzel (der n8n-Fall). */
const SOURCE = value("source") ?? "";

/** Knoten an der Wurzel, die nie Mails waren. */
const NOT_MAIL = new Set(["mailFolders", "users", "admins", "userDirectory", "emails"]);

function fail(message) {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

if (EMAIL === undefined && UID_ARG === undefined) {
  fail("--email <adresse> oder --uid <kennung> angeben: wem der Bestand gehören soll.");
}

const databaseURL = process.env.FIREBASE_DATABASE_URL?.trim();
if (!databaseURL) fail("FIREBASE_DATABASE_URL ist nicht gesetzt.");
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
  fail("GOOGLE_APPLICATION_CREDENTIALS ist nicht gesetzt (Service-Account-JSON).");
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL });

const db = admin.database();

async function resolveUid() {
  if (UID_ARG !== undefined) return UID_ARG;
  try {
    const user = await admin.auth().getUserByEmail(EMAIL);
    return user.uid;
  } catch {
    fail(`Es gibt kein Konto für ${EMAIL}. Erst den Benutzer anlegen, dann migrieren.`);
  }
}

/** Mails an der alten Stelle einsammeln. */
async function readLegacyEmails() {
  const path = SOURCE.replace(/^\/+|\/+$/g, "");
  const snapshot = await db.ref(path === "" ? "/" : path).get();
  const raw = snapshot.val();
  if (raw === null || typeof raw !== "object") return {};

  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    // An der Wurzel liegen zwischen den Mails auch die Verwaltungsknoten.
    if (path === "" && NOT_MAIL.has(key)) continue;
    // Eine Mail erkennt man daran, dass sie überhaupt Inhalt hat.
    const looksLikeMail =
      typeof entry.betreff === "string" ||
      typeof entry.subject === "string" ||
      typeof entry.absender === "string" ||
      typeof entry.sender === "string";
    if (!looksLikeMail) continue;
    out[key] = entry;
  }
  return out;
}

async function readLegacyFolders() {
  const snapshot = await db.ref("mailFolders").get();
  const raw = snapshot.val();
  return raw !== null && typeof raw === "object" ? raw : {};
}

async function main() {
  const uid = await resolveUid();
  const [emails, folders] = await Promise.all([readLegacyEmails(), readLegacyFolders()]);

  const emailCount = Object.keys(emails).length;
  const folderCount = Object.keys(folders).length;

  console.log(`Ziel:    users/${uid}`);
  console.log(`Quelle:  ${SOURCE === "" ? "(Wurzel)" : SOURCE}`);
  console.log(`Mails:   ${emailCount}`);
  console.log(`Ordner:  ${folderCount}`);

  if (emailCount === 0 && folderCount === 0) {
    console.log("\nNichts zu migrieren.");
    return;
  }

  if (DRY_RUN) {
    const sample = Object.entries(emails).slice(0, 5);
    if (sample.length > 0) {
      console.log("\nBeispiele:");
      for (const [key, entry] of sample) {
        console.log(`  ${key}  ${entry.betreff ?? entry.subject ?? "(ohne Betreff)"}`);
      }
    }
    console.log("\nTrockenlauf — es wurde nichts geschrieben.");
    return;
  }

  // Erst schreiben …
  const writes = {};
  for (const [key, entry] of Object.entries(emails)) {
    writes[`users/${uid}/emails/${key}`] = entry;
  }
  for (const [key, entry] of Object.entries(folders)) {
    writes[`users/${uid}/mailFolders/${key}`] = entry;
  }
  await db.ref().update(writes);
  console.log("\nKopiert.");

  // … den Benutzer als Administrator eintragen, sonst käme niemand an die
  // Benutzerverwaltung heran.
  await db.ref(`admins/${uid}`).set(true);
  const user = await admin.auth().getUser(uid);
  await db.ref(`userDirectory/${uid}`).update({
    uid,
    email: user.email ?? "",
    displayName: user.displayName ?? "",
    disabled: user.disabled === true,
    createdAt: user.metadata?.creationTime ?? new Date().toISOString(),
  });
  console.log("Als Administrator eingetragen.");

  // … und erst danach aufräumen.
  if (KEEP_SOURCE) {
    console.log("\n--keep-source: der alte Stand bleibt liegen.");
    console.log("Er ist über die neuen Regeln nicht mehr lesbar, belegt aber Platz.");
    return;
  }

  const deletions = {};
  const prefix = SOURCE.replace(/^\/+|\/+$/g, "");
  for (const key of Object.keys(emails)) {
    deletions[prefix === "" ? key : `${prefix}/${key}`] = null;
  }
  for (const key of Object.keys(folders)) {
    deletions[`mailFolders/${key}`] = null;
  }
  await db.ref().update(deletions);
  console.log("Alten Stand entfernt.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
