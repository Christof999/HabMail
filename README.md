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
4. Der Datensatz landet in der Realtime Database. Der Schlüssel wird aus der
   Message-ID abgeleitet, dieselbe Mail kann also nicht doppelt entstehen.
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

Im Proxy einen Key anlegen, der abholen darf:

```bash
node scripts/emailproxy-admin.mjs client:create --id habmail
node scripts/emailproxy-admin.mjs client:receive --id habmail
```

Den Key und die Proxy-URL bei den Functions hinterlegen:

```bash
npx firebase functions:secrets:set EMAILPROXY_KEY
npx firebase functions:secrets:set GEMINI_API_KEY
```

`EMAILPROXY_URL`, `EMAILS_PATH` und `GEMINI_MODEL` sind gewöhnliche
Umgebungsvariablen der Function.

> **Wichtig:** `EMAILS_PATH` (Functions) und `VITE_FIREBASE_EMAILS_PATH`
> (Oberfläche) müssen auf denselben Pfad zeigen. Sonst schreibt die Function
> Mails dorthin, wo die App nicht hinsieht.

### 3. Vercel

Für die Serverless-Funktionen unter `api/`:

```
FIREBASE_PROJECT_ID=...
GEMINI_API_KEY=...
EMAILPROXY_URL=https://dein-proxy.vercel.app
EMAILPROXY_ADMIN_KEY=...        # nur hier, nie im Frontend
SMTP_HOST=...                   # für /api/send-mail (Antworten)
SMTP_USER=...
SMTP_PASS=...
```

Der Admin-Key liegt ausschließlich auf dem Server: `api/mailboxes.ts` prüft das
Firebase-Token des angemeldeten Nutzers und reicht die Anfrage erst dann an den
Proxy weiter.

## Postfächer hinzufügen

In der Oberfläche über **Postfächer verwalten**. Nötig sind Adresse, Passwort
und der SMTP-Server; den IMAP-Server schlägt das Formular vor. Ohne IMAP-Server
kann über das Postfach nur verschickt werden.

Bei Gmail und GMX braucht es ein App-Passwort, nicht das Kontopasswort.

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
  gesetztes `INGEST_TOKEN` weiterhin Daten von jedem an.

## Skripte

```bash
npm run dev       # Entwicklungsserver
npm run build     # tsc -b && vite build
npm run lint      # ESLint
```
