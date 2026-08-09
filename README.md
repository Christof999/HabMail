# HabMail

Posteingang für die Buchhaltung. Mails aus mehreren Postfächern laufen hier
zusammen, werden von einer KI einsortiert (Rechnung, Anfrage, Mahnung …) und
lassen sich durchsuchen, ablegen und beantworten.

```
Postfach A ─┐                        ┌─ Kategorie (Rechnung/Anfrage/…)
Postfach B ─┼─IMAP─► Email-Proxy ─►  ┤  Rechnungsdaten (Betrag, Nummer, Frist)
Postfach C ─┘        (eigenes Repo)  └─ Realtime Database ─► HabMail (React)
```

Die Zugangsdaten der Postfächer liegen **nicht** in diesem Projekt, sondern
verschlüsselt im [Email-Proxy](https://github.com/Christof999/Emailproxy).
HabMail kennt nur dessen URL und einen API-Key.

## Wer sieht was

HabMail ist ein Mehrbenutzer-System. Jeder Benutzer hat seinen eigenen
Posteingang und seine eigenen Postfächer:

- **Mails und Ordner** liegen unter `users/<uid>/`. Die Regeln in
  [`database.rules.json`](database.rules.json) erlauben jedem Benutzer nur den
  Zugriff auf seinen eigenen Zweig.
- **Postfächer** trägt der Proxy unter dem Eigentümer `habmail:<uid>`. Ein
  Benutzer sieht ausschließlich seine eigenen — nicht die anderer Benutzer und
  nicht die anderer Projekte, die denselben Proxy benutzen.
- **Konten legt ein Administrator an.** Eine Selbstregistrierung gibt es nicht.

Der **Admin-Key des Proxys gehört nicht in dieses Projekt**. Er darf alles,
auch die Postfächer aller anderen Projekte lesen und löschen. HabMail benutzt
einen gewöhnlichen Client-Key, der auf seine eigenen Postfächer beschränkt ist.

## Aufbau

| Teil | Wo | Wofür |
|---|---|---|
| Oberfläche | `src/` | React + Vite, Firebase Auth, Realtime-Listener |
| Serverless-API | `api/` | läuft auf Vercel: KI-Suche, Mailversand, Postfach-Verwaltung |
| Hintergrund | `functions/` | Firebase Functions: Mails abholen und kategorisieren |
| Regeln | `database.rules.json` | wer was in der Realtime Database darf |

### Wie eine Mail hereinkommt

1. `pollMailboxes` (Firebase Function) läuft alle fünf Minuten.
2. Sie fragt den Email-Proxy, welche Postfächer empfangen können, und holt je
   Postfach die neuen Mails über `GET /api/receive`.
3. Jede Mail geht an Gemini: Kategorie, Zusammenfassung, Priorität — bei
   Rechnungen zusätzlich Nummer, Betrag, Datum und Fälligkeit.
4. Der Datensatz landet unter `users/<uid>/emails` — welcher Benutzer gemeint
   ist, sagt der Proxy über den Eigentümer des Postfachs. Der Schlüssel wird
   aus der Message-ID abgeleitet, dieselbe Mail kann also nicht doppelt
   entstehen. Postfächer ohne Eigentümer werden übersprungen: bei denen wüsste
   niemand, in wessen Posteingang sie gehören.
5. Erst danach wird dem Proxy bestätigt, dass die Mails durch sind. Bricht
   etwas ab, kommen sie beim nächsten Lauf erneut — das ist Absicht.

## Einrichten

### 1. Firebase

Realtime Database und E-Mail-Anmeldung aktivieren, dann die `VITE_FIREBASE_*`-Werte
aus der Projekt-Konfiguration in `.env.local` eintragen (siehe
[`.env.example`](.env.example)).

```bash
npm install
npm run dev
```

Datenbankregeln und Functions ausrollen:

```bash
npx firebase deploy --only database,functions
```

Die Functions setzen den Blaze-Tarif voraus — der geplante Lauf ist eine
Cloud-Scheduler-Aufgabe.

### 2. Email-Proxy verbinden

Im Proxy einen Client anlegen und ihm genau zwei Befugnisse geben — mehr
braucht HabMail nicht, und mehr soll es auch nicht haben:

```bash
node scripts/emailproxy-admin.mjs client:create --id habmail
node scripts/emailproxy-admin.mjs client:own-mailboxes --id habmail   # eigene Postfächer
node scripts/emailproxy-admin.mjs client:receive --id habmail         # abholen
```

`client:create` gibt den Key **einmalig** aus. Ihn bei den Functions und in
Vercel hinterlegen:

```bash
npx firebase functions:secrets:set EMAILPROXY_KEY
npx firebase functions:secrets:set GEMINI_API_KEY
```

`EMAILPROXY_URL`, `ADMIN_UIDS` und `GEMINI_MODEL` sind gewöhnliche
Umgebungsvariablen der Function.

### 2b. Ersten Administrator festlegen

Ohne Administrator kommt niemand an die Benutzerverwaltung. Der erste kommt aus
`ADMIN_UIDS` (kommagetrennte Firebase-UIDs) — oder das Migrationsskript unten
trägt ihn für dich ein.

### 3. Vercel

Für die Serverless-Funktionen unter `api/`:

```
FIREBASE_PROJECT_ID=...
GEMINI_API_KEY=...
EMAILPROXY_URL=https://dein-proxy.vercel.app
EMAILPROXY_KEY=ep_...           # nur hier, nie im Frontend
SMTP_HOST=...                   # für /api/send-mail (Antworten)
SMTP_USER=...
SMTP_PASS=...
```

`api/mailboxes.ts` prüft das Firebase-Token des angemeldeten Nutzers und
schickt dessen UID als `subject` an den Proxy — genommen aus dem geprüften
Token, nie aus dem Request-Body. Ein Angemeldeter kann deshalb nicht die
Postfächer eines anderen anfragen.

## Benutzer und Postfächer

**Benutzer verwalten** (nur für Administratoren sichtbar): Konten anlegen,
Passwörter setzen, sperren, Adminrechte vergeben. Ein Konto zu löschen entfernt
auch dessen Mails und Ordner — die Postfächer im Proxy bleiben bestehen.

**Postfächer verwalten** (für jeden Benutzer, für seine eigenen): Adresse,
Passwort und SMTP-Server eintragen; den IMAP-Server schlägt das Formular vor.
Ohne IMAP-Server kann über das Postfach nur verschickt werden.

Bei Gmail und GMX braucht es ein App-Passwort, nicht das Kontopasswort.

## Bestand migrieren

Wer HabMail schon vor der Benutzertrennung benutzt hat, hat Mails flach an der
Wurzel der Datenbank liegen. Dieses Skript zieht sie um und trägt dich als
Administrator ein:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/pfad/zum/service-account.json
export FIREBASE_DATABASE_URL=https://<projekt>-default-rtdb.europe-west1.firebasedatabase.app

node functions/scripts/migrate-to-users.mjs --email du@example.com --dry-run
node functions/scripts/migrate-to-users.mjs --email du@example.com
```

Lagen die Mails in einem Unterordner, `--source emails` mitgeben. Kopiert wird
zuerst, gelöscht erst danach — ein Abbruch mittendrin lässt den alten Stand
unangetastet. `--keep-source` lässt ihn ohnehin liegen.

> Der Benutzer muss vorher existieren. Bei einem leeren Projekt also erst über
> `ADMIN_UIDS` anmelden und dann migrieren.

## Kategorien

Definiert in [`src/categories.ts`](src/categories.ts) — und, weil die Functions
ein eigenes Deploy-Paket sind, gespiegelt in
[`functions/categories.js`](functions/categories.js). **Änderungen gehören in
beide Dateien.**

`rechnung`, `mahnung`, `angebot`, `bestellung`, `lieferung`, `anfrage`,
`vertrag`, `newsletter`, `sonstiges`

Ältere Datensätze mit Freitext-Kategorie werden beim Einlesen über
`normalizeCategory` auf dieses Schema abgebildet; es muss nichts neu eingelesen
werden.

## Bekannte Baustellen

- **Anhänge liegen als Base64 in der Realtime Database.** Das trägt nicht weit:
  der Client lädt beim Start den ganzen Baum. Dateien über 1 MB werden deshalb
  schon jetzt nur mit Namen und Größe gespeichert
  (`MAX_INLINE_ATTACHMENT_BYTES`). Für ein echtes Belegarchiv gehören sie nach
  Firebase Storage.
- **Das Monatsarchiv fehlt noch.** Das Feld `period` (YYYY-MM) wird bereits
  gefüllt, ausgewertet wird es noch nicht.
- **Der Ingest-Endpunkt** (`ingest_k7mN9pQ2wR4xY8z`, für n8n) nimmt ohne
  gesetztes `INGEST_TOKEN` weiterhin Daten von jedem an — und schreibt an die
  alte, flache Stelle, die die App nicht mehr liest. Wer noch n8n benutzt,
  sollte auf das Abholen über den Proxy umstellen.
- **Das Kategorie-Schema steht doppelt** (`src/categories.ts` und
  `functions/categories.js`), ebenso die Pfade (`src/paths.ts` und
  `functions/paths.js`). Das ist die Deploy-Grenze zwischen App und Functions —
  Änderungen gehören in beide Dateien.

## Skripte

```bash
npm run dev       # Entwicklungsserver
npm run build     # tsc -b && vite build
npm run lint      # ESLint
```
