/**
 * Nachsehen, ob der Zeitplan für das Abholen wirklich existiert — und ihn
 * anlegen, wenn nicht.
 *
 * Hintergrund: `firebase deploy --only functions` soll für jede onSchedule-
 * Function selbst einen Cloud-Scheduler-Job anlegen. Das misslingt still, wenn
 * dem Dienstkonto Rechte fehlen: das Ausrollen meldet Erfolg, der Job fehlt,
 * und niemand merkt es außer daran, dass keine Mails mehr ankommen. Genau das
 * ist passiert.
 *
 * Deshalb prüft dieses Skript nach jedem Ausrollen nach. Fehlt der Job, legt es
 * ihn selbst an — aber nicht als Kopie dessen, was Firebase versucht hat:
 *
 *   Firebase zeigt auf die Function `pollMailboxes` direkt. Dafür muss dem
 *   Dienstkonto des Zeitplans das Recht „Cloud Run-Aufrufer" eingetragen
 *   werden, und genau daran scheitert es meistens.
 *
 *   Dieses Skript zeigt stattdessen auf `pollMailboxesNow` — einen öffentlichen
 *   Endpunkt, der sich über POLL_TRIGGER_TOKEN ausweist. Der braucht keine
 *   Google-Rechte, nur den Zeitplan selbst.
 *
 * Ausgeführt wird das mit den Zugangsdaten aus GOOGLE_APPLICATION_CREDENTIALS,
 * die der Workflow schon abgelegt hat.
 */

import { GoogleAuth } from "google-auth-library";

const API = "https://cloudscheduler.googleapis.com/v1";

/** Der Job, den dieses Skript selbst anlegt. */
const OWN_JOB_ID = "habmail-poll-mailboxes";
/** Woran ein von Firebase angelegter Job zu erkennen ist. */
const FIREBASE_JOB_PATTERN = /pollMailboxes/i;

const SCHEDULE = "*/5 * * * *";
const TIME_ZONE = "Europe/Berlin";

function fail(message) {
  console.log(`::error::${message}`);
  process.exitCode = 1;
}

function notice(message) {
  console.log(message);
}

/**
 * Ein Aufruf gegen die Cloud-Scheduler-API.
 *
 * Der Statuscode wird mit zurückgegeben statt geworfen: 403 und 404 bedeuten
 * hier Verschiedenes — „darf nicht nachsehen" gegen „ist nicht da" — und beides
 * braucht eine eigene Antwort an den Nutzer.
 */
async function callApi(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  let data = {};
  const raw = await response.text();
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw: raw.slice(0, 300) };
  }
  return { status: response.status, ok: response.ok, data };
}

/** Die Meldung der API auf einen Satz eindampfen. */
function apiMessage(result) {
  return String(result.data?.error?.message ?? result.data?.raw ?? `HTTP ${result.status}`).slice(
    0,
    300,
  );
}

/**
 * Alle Orte durchsuchen, nicht nur den erwarteten. Ein Job kann in einer
 * anderen Region liegen als gedacht — und „ich finde ihn nicht" ist dann eine
 * falsche Diagnose.
 */
async function findExistingJobs(token, projectId, preferredLocation) {
  const locations = new Set([preferredLocation]);

  const listed = await callApi(token, `/projects/${projectId}/locations`);
  if (listed.ok) {
    for (const entry of listed.data.locations ?? []) {
      if (typeof entry.locationId === "string") locations.add(entry.locationId);
    }
  } else if (listed.status === 403) {
    return { forbidden: true, jobs: [], locations: [] };
  }

  const jobs = [];
  for (const location of locations) {
    const result = await callApi(token, `/projects/${projectId}/locations/${location}/jobs`);
    if (result.status === 403) return { forbidden: true, jobs: [], locations: [...locations] };
    if (!result.ok) continue;
    for (const job of result.data.jobs ?? []) jobs.push(job);
  }
  return { forbidden: false, jobs, locations: [...locations] };
}

function shortName(job) {
  return String(job.name ?? "").split("/").pop();
}

async function main() {
  const projectId = (process.env.PROJECT_ID ?? "").trim();
  const location = (process.env.SCHEDULER_LOCATION ?? "europe-west1").trim();
  const pollToken = (process.env.POLL_TRIGGER_TOKEN ?? "").trim();
  const pollUrl =
    (process.env.POLL_URL ?? "").trim() ||
    `https://${location}-${projectId}.cloudfunctions.net/pollMailboxesNow`;

  if (projectId === "") {
    fail("PROJECT_ID fehlt — der Zeitplan lässt sich nicht prüfen.");
    return;
  }

  let token;
  try {
    token = await new GoogleAuth({
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    }).getAccessToken();
  } catch (error) {
    notice(`::warning::Kein Zugriffstoken für die Prüfung (${error?.message ?? error}).`);
    notice(`Von Hand nachsehen: https://console.cloud.google.com/cloudscheduler?project=${projectId}`);
    return;
  }

  const { forbidden, jobs } = await findExistingJobs(token, projectId, location);

  if (forbidden) {
    notice("::warning::Das Dienstkonto darf die Zeitpläne nicht lesen (403).");
    notice("Fehlende Rolle: Cloud Scheduler-Administrator.");
    notice(`  Rechte vergeben: https://console.cloud.google.com/iam-admin/iam?project=${projectId}`);
    return;
  }

  notice(
    jobs.length === 0
      ? "Vorhandene Zeitpläne: keine"
      : `Vorhandene Zeitpläne: ${jobs.map((job) => `${shortName(job)} (${job.state})`).join(", ")}`,
  );

  const existing = jobs.find(
    (job) => FIREBASE_JOB_PATTERN.test(shortName(job)) || shortName(job) === OWN_JOB_ID,
  );

  // Der einfache Fall: es gibt einen und er läuft.
  if (existing !== undefined && existing.state === "ENABLED") {
    notice(`Zeitplan aktiv: ${shortName(existing)} — die Mails kommen alle fünf Minuten von selbst.`);
    return;
  }

  // Pausiert kommt vor, wenn jemand in der Konsole daran war.
  if (existing !== undefined) {
    const resumed = await callApi(token, `/${existing.name}:resume`, { method: "POST", body: {} });
    if (resumed.ok) {
      notice(`Zeitplan ${shortName(existing)} stand auf ${existing.state} und läuft wieder.`);
    } else {
      fail(
        `Zeitplan ${shortName(existing)} steht auf ${existing.state} und ließ sich nicht starten: ${apiMessage(resumed)}`,
      );
    }
    return;
  }

  // Ab hier: es gibt keinen. Firebase hat ihn nicht angelegt — also selbst.
  notice("::warning::Firebase hat keinen Zeitplan für pollMailboxes angelegt. Das erklärt, warum von selbst nichts ankam.");

  if (pollToken === "") {
    fail(
      "Zum Anlegen fehlt POLL_TRIGGER_TOKEN. Das Secret setzen (ein selbst ausgedachtes langes " +
        "Passwort) und diesen Workflow noch einmal laufen lassen — dann legt er den Zeitplan selbst an.",
    );
    return;
  }

  const created = await callApi(token, `/projects/${projectId}/locations/${location}/jobs`, {
    method: "POST",
    body: {
      name: `projects/${projectId}/locations/${location}/jobs/${OWN_JOB_ID}`,
      description: "HabMail: alle fünf Minuten neue Mails abholen",
      schedule: SCHEDULE,
      timeZone: TIME_ZONE,
      // So lange darf ein Lauf dauern; die Function selbst hat 540 Sekunden.
      attemptDeadline: "540s",
      httpTarget: {
        uri: pollUrl,
        httpMethod: "POST",
        // Kein OIDC: pollMailboxesNow weist sich über das Token aus. Genau
        // deshalb braucht dieser Weg kein „Cloud Run-Aufrufer".
        headers: { Authorization: `Bearer ${pollToken}` },
      },
    },
  });

  if (created.ok) {
    notice(`Zeitplan ${OWN_JOB_ID} angelegt — Ziel: ${pollUrl}`);
    notice("Ab jetzt werden die Mails alle fünf Minuten von selbst abgeholt.");
    return;
  }

  if (created.status === 403) {
    fail(
      "Der Zeitplan ließ sich nicht anlegen: dem Dienstkonto fehlt die Rolle " +
        "Cloud Scheduler-Administrator. " +
        `Vergeben unter https://console.cloud.google.com/iam-admin/iam?project=${projectId} — ` +
        "oder ersatzweise den Workflow „Mails abholen“ einschalten, der ohne Google-Rechte auskommt.",
    );
    return;
  }

  fail(`Der Zeitplan ließ sich nicht anlegen: ${apiMessage(created)}`);
}

await main();
