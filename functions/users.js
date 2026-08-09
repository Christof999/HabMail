/**
 * Benutzerverwaltung.
 *
 * Es gibt bewusst keine Selbstregistrierung: HabMail ist ein
 * Buchhaltungs-Posteingang, niemand soll sich dort selbst ein Konto anlegen
 * können. Konten legt ein Administrator an.
 *
 * Wer Administrator ist, steht in der Datenbank unter `admins/<uid>` und wird
 * hier serverseitig geprüft — nie im Browser. Die allerersten Administratoren
 * kommen aus der Umgebungsvariable ADMIN_UIDS, sonst käme man nie hinein.
 */

const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { USER_DIRECTORY_PATH, ADMINS_PATH, userRootPath } = require("./paths");
const { migrateLegacyData } = require("./migrate");

/** Administratoren aus der Umgebung — der Startpunkt, bevor es Einträge gibt. */
function bootstrapAdminUids() {
  return (process.env.ADMIN_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter((uid) => uid.length > 0);
}

async function isAdmin(uid) {
  if (bootstrapAdminUids().includes(uid)) return true;
  const snapshot = await admin.database().ref(`${ADMINS_PATH}/${uid}`).get();
  return snapshot.val() === true;
}

async function requireAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Nicht angemeldet.");
  }
  if (!(await isAdmin(uid))) {
    throw new HttpsError(
      "permission-denied",
      "Nur Administratoren dürfen Benutzer verwalten.",
    );
  }
  return uid;
}

function requireString(value, field, { max = 200 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpsError("invalid-argument", `"${field}" fehlt.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new HttpsError("invalid-argument", `"${field}" ist zu lang.`);
  }
  return text;
}

/** Was der Verwaltung angezeigt wird — nie Passwörter, die kennt Firebase Auth allein. */
function toDirectoryEntry(user, extra = {}) {
  return {
    uid: user.uid,
    email: user.email ?? "",
    displayName: user.displayName ?? "",
    disabled: user.disabled === true,
    createdAt: user.metadata?.creationTime ?? new Date().toISOString(),
    ...extra,
  };
}

/** Benutzer anlegen. Das Passwort setzt der Administrator und gibt es weiter. */
const createUser = onCall(async (request) => {
  await requireAdmin(request);

  const email = requireString(request.data?.email, "email", { max: 320 });
  const password = requireString(request.data?.password, "password", { max: 200 });
  if (password.length < 8) {
    throw new HttpsError(
      "invalid-argument",
      "Das Passwort muss mindestens 8 Zeichen haben.",
    );
  }
  const displayName =
    typeof request.data?.displayName === "string"
      ? request.data.displayName.trim().slice(0, 120)
      : "";

  let user;
  try {
    user = await admin.auth().createUser({
      email,
      password,
      ...(displayName === "" ? {} : { displayName }),
    });
  } catch (error) {
    if (error?.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", `Es gibt bereits ein Konto für ${email}.`);
    }
    if (error?.code === "auth/invalid-email") {
      throw new HttpsError("invalid-argument", `"${email}" ist keine gültige Adresse.`);
    }
    throw new HttpsError("internal", `Konto konnte nicht angelegt werden: ${error?.message}`);
  }

  const entry = toDirectoryEntry(user);
  await admin.database().ref(`${USER_DIRECTORY_PATH}/${user.uid}`).set(entry);

  if (request.data?.isAdmin === true) {
    await admin.database().ref(`${ADMINS_PATH}/${user.uid}`).set(true);
  }

  return { user: { ...entry, isAdmin: request.data?.isAdmin === true } };
});

/** Alle Benutzer, angereichert um das Admin-Kennzeichen. */
const listUsers = onCall(async (request) => {
  await requireAdmin(request);

  const [result, adminsSnapshot] = await Promise.all([
    admin.auth().listUsers(1000),
    admin.database().ref(ADMINS_PATH).get(),
  ]);
  const admins = adminsSnapshot.val() ?? {};
  const bootstrap = bootstrapAdminUids();

  return {
    users: result.users.map((user) =>
      toDirectoryEntry(user, {
        isAdmin: admins[user.uid] === true || bootstrap.includes(user.uid),
        // Aus der Umgebung gesetzte Administratoren lassen sich hier nicht abwählen.
        adminFromEnv: bootstrap.includes(user.uid),
      }),
    ),
  };
});

/** Sperren, entsperren, Passwort setzen, Adminrechte vergeben. */
const updateUser = onCall(async (request) => {
  const callerUid = await requireAdmin(request);
  const uid = requireString(request.data?.uid, "uid");

  const changes = {};
  if (typeof request.data?.disabled === "boolean") {
    if (uid === callerUid && request.data.disabled) {
      throw new HttpsError("failed-precondition", "Du kannst dich nicht selbst sperren.");
    }
    changes.disabled = request.data.disabled;
  }
  if (typeof request.data?.password === "string" && request.data.password !== "") {
    if (request.data.password.length < 8) {
      throw new HttpsError(
        "invalid-argument",
        "Das Passwort muss mindestens 8 Zeichen haben.",
      );
    }
    changes.password = request.data.password;
  }
  if (typeof request.data?.displayName === "string") {
    changes.displayName = request.data.displayName.trim().slice(0, 120);
  }

  if (Object.keys(changes).length > 0) {
    await admin.auth().updateUser(uid, changes);
  }

  if (typeof request.data?.isAdmin === "boolean") {
    if (uid === callerUid && !request.data.isAdmin) {
      throw new HttpsError(
        "failed-precondition",
        "Du kannst dir nicht selbst die Adminrechte entziehen.",
      );
    }
    const ref = admin.database().ref(`${ADMINS_PATH}/${uid}`);
    await (request.data.isAdmin ? ref.set(true) : ref.remove());
  }

  const user = await admin.auth().getUser(uid);
  const entry = toDirectoryEntry(user);
  await admin.database().ref(`${USER_DIRECTORY_PATH}/${uid}`).update(entry);
  return { user: entry };
});

/**
 * Benutzer entfernen — samt seiner Mails und Ordner. Die Postfächer im
 * Email-Proxy bleiben bestehen; die kann nur die App löschen, die sie
 * angelegt hat, und dafür braucht es den Client-Key.
 */
const deleteUser = onCall(async (request) => {
  const callerUid = await requireAdmin(request);
  const uid = requireString(request.data?.uid, "uid");

  if (uid === callerUid) {
    throw new HttpsError("failed-precondition", "Du kannst dich nicht selbst löschen.");
  }

  await admin.auth().deleteUser(uid);
  await Promise.all([
    admin.database().ref(userRootPath(uid)).remove(),
    admin.database().ref(`${USER_DIRECTORY_PATH}/${uid}`).remove(),
    admin.database().ref(`${ADMINS_PATH}/${uid}`).remove(),
  ]);

  return { deleted: uid };
});

/**
 * Den alten, flach liegenden Bestand einem Benutzer zuordnen.
 *
 * Dasselbe wie functions/scripts/migrate-to-users.mjs, nur ohne Terminal:
 * ein Administrator löst es aus der Oberfläche aus. Standardmäßig ein
 * Trockenlauf — geschrieben wird erst, wenn dryRun ausdrücklich false ist.
 */
const migrateLegacy = onCall(async (request) => {
  const callerUid = await requireAdmin(request);
  const targetUid =
    typeof request.data?.uid === "string" && request.data.uid.trim() !== ""
      ? request.data.uid.trim()
      : callerUid;

  // Ein Ziel, das es nicht gibt, würde einen verwaisten Zweig anlegen.
  try {
    await admin.auth().getUser(targetUid);
  } catch {
    throw new HttpsError("not-found", `Es gibt keinen Benutzer mit der Kennung ${targetUid}.`);
  }

  try {
    return await migrateLegacyData({
      targetUid,
      source: typeof request.data?.source === "string" ? request.data.source : "",
      dryRun: request.data?.dryRun !== false,
      keepSource: request.data?.keepSource === true,
    });
  } catch (error) {
    throw new HttpsError("internal", `Migration fehlgeschlagen: ${error?.message}`);
  }
});

/** Damit die Oberfläche weiß, ob sie die Verwaltung überhaupt anbieten soll. */
const whoAmI = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Nicht angemeldet.");
  return { uid, isAdmin: await isAdmin(uid) };
});

module.exports = {
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  migrateLegacy,
  whoAmI,
  isAdmin,
};
