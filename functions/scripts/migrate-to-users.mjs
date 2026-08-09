#!/usr/bin/env node
/**
 * Bestand auf die Benutzertrennung umstellen — die Variante für die
 * Kommandozeile. Wer kein Terminal zur Hand hat, macht dasselbe über
 * „Benutzer verwalten → Bestand übernehmen“ in der App.
 *
 * Die Logik selbst steht in ../migrate.js und ist für beide Wege dieselbe.
 *
 * Vorbereitung:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/pfad/zum/service-account.json
 *   export FIREBASE_DATABASE_URL=https://<projekt>-default-rtdb.europe-west1.firebasedatabase.app
 *
 * Erst ansehen, dann umziehen:
 *   node functions/scripts/migrate-to-users.mjs --email du@example.com --dry-run
 *   node functions/scripts/migrate-to-users.mjs --email du@example.com
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

function fail(message) {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

const EMAIL = value("email");
const UID_ARG = value("uid");

if (EMAIL === undefined && UID_ARG === undefined) {
  fail("--email <adresse> oder --uid <kennung> angeben: wem der Bestand gehören soll.");
}

const databaseURL = process.env.FIREBASE_DATABASE_URL?.trim();
if (!databaseURL) fail("FIREBASE_DATABASE_URL ist nicht gesetzt.");
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
  fail("GOOGLE_APPLICATION_CREDENTIALS ist nicht gesetzt (Service-Account-JSON).");
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL });

const { migrateLegacyData, promoteToAdmin } = require("../migrate");

async function resolveUid() {
  if (UID_ARG !== undefined) return UID_ARG;
  try {
    const user = await admin.auth().getUserByEmail(EMAIL);
    return user.uid;
  } catch {
    fail(`Es gibt kein Konto für ${EMAIL}. Erst den Benutzer anlegen, dann migrieren.`);
  }
}

async function main() {
  const targetUid = await resolveUid();
  const dryRun = flag("dry-run");

  const result = await migrateLegacyData({
    targetUid,
    source: value("source") ?? "",
    dryRun,
    keepSource: flag("keep-source"),
  });

  console.log(`Ziel:    users/${result.targetUid}`);
  console.log(`Quelle:  ${result.source === "" ? "(Wurzel)" : result.source}`);
  console.log(`Mails:   ${result.emails}`);
  console.log(`Ordner:  ${result.folders}`);

  if (result.emails === 0 && result.folders === 0) {
    console.log("\nNichts zu migrieren.");
    return;
  }

  if (dryRun) {
    if (result.samples.length > 0) {
      console.log("\nBeispiele:");
      for (const subject of result.samples) console.log(`  ${subject}`);
    }
    console.log("\nTrockenlauf — es wurde nichts geschrieben.");
    return;
  }

  console.log("\nKopiert.");
  await promoteToAdmin(targetUid);
  console.log("Als Administrator eingetragen.");

  if (result.sourceRemoved) console.log("Alten Stand entfernt.");
  else console.log("--keep-source: der alte Stand bleibt liegen.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
