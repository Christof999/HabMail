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

## Einrichten ohne Terminal

Der ganze Ablauf geht über Weboberflächen — Browser reicht, auch auf dem Handy.

1. **Client im Email-Proxy anlegen.** Die Startseite des Proxys öffnen →
   *App einrichten* → Admin-Key einfügen, Name `habmail`, *Client anlegen*.
   Der `ep_…`-Schlüssel wird einmalig angezeigt: kopieren.
2. **GitHub-Secrets setzen.** Repo → Settings → Secrets and variables → Actions:
   `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_PROJECT_ID`, `EMAILPROXY_KEY`,
   `GEMINI_API_KEY`. Unter *Variables*: `EMAILPROXY_URL` und `ADMIN_UIDS`
   (deine Firebase-UID, zu finden in der Firebase Console unter Authentication).
3. **Google-APIs aktivieren und dem Dienstkonto Rechte geben.** Beides einmalig
   und beides als Projektinhaber. Die genauen Links mit deiner Projekt-ID gibt
   der Workflow aus, wenn er scheitert — einfach einmal laufen lassen und den
   Schritt *Hilfe bei Fehlern* aufklappen. Nötig sind:
   - die APIs Cloud Functions, Cloud Build, Artifact Registry, Cloud Run,
     Eventarc, Pub/Sub, Cloud Scheduler und Cloud Storage,
   - für das Konto `firebase-adminsdk-…` die Rollen *Firebase Admin*,
     *Cloud Functions Admin*, *Dienstkontonutzer*, *Cloud Build-Bearbeiter*,
     *Artifact Registry-Administrator*.
4. **Ausrollen.** Repo → Actions → *Firebase ausrollen* → *Run workflow*. Die
   Datenbankregeln gehen in einem eigenen Schritt raus, vor den Functions —
   sie schotten die Daten der Benutzer ab und sollen auch dann live sein, wenn
   an den Functions noch etwas fehlt.
5. **Vercel-Variablen setzen** (Vercel-Dashboard → Settings → Environment
   Variables), siehe Abschnitt 3 unten. Danach neu deployen.
6. **Anmelden**, dann *Benutzer verwalten* → *Bestand übernehmen* → *Nachsehen*,
   um alte Mails in deinen Posteingang zu holen.
7. **Postfach hinzufügen**: *Postfächer verwalten* → *Postfach hinzufügen*.
   IONOS ist vorausgewählt — Adresse und Passwort reichen.

> Die Schlüssel landen als Umgebungsvariablen der Functions, nicht im Google
> Secret Manager. Das spart die Secret-Manager-Einrichtung; wer die strengere
> Variante will, setzt sie mit `firebase functions:secrets:set` und trägt sie
> unter `secrets:` in `functions/index.js` ein.

Die Abschnitte unten beschreiben dasselbe ausführlicher, inklusive der
Terminal-Varianten.

## Einrichten

### 1. Firebase

Realtime Database und E-Mail-Anmeldung aktivieren, dann die `VITE_FIREBASE_*`-Werte
aus der Projekt-Konfiguration in `.env.local` eintragen (siehe
[`.env.example`](.env.example)).

```bash
npm install
npm run dev
```

Datenbankregeln und Functions ausrollen — entweder über den Workflow
[`.github/workflows/firebase-deploy.yml`](.github/workflows/firebase-deploy.yml)
(Actions → *Firebase ausrollen* → *Run workflow*, kein Terminal nötig) oder:

```bash
npx firebase deploy --only database,functions
```

Die Functions setzen den Blaze-Tarif voraus — der geplante Lauf ist eine
Cloud-Scheduler-Aufgabe.

### 2. Email-Proxy verbinden

HabMail braucht im Proxy einen Client mit genau zwei Befugnissen — mehr nicht,
und mehr soll es auch nicht haben. Am einfachsten über die **Startseite des
Proxys**, Abschnitt *App einrichten*: Admin-Key einfügen, Name `habmail`,
*Client anlegen*. Der Key wird einmalig angezeigt.

Auf der Kommandozeile geht dasselbe so:

```bash
node scripts/emailproxy-admin.mjs client:create --id habmail
node scripts/emailproxy-admin.mjs client:own-mailboxes --id habmail   # eigene Postfächer
node scripts/emailproxy-admin.mjs client:receive --id habmail         # abholen
```

Der Key gehört dann in die GitHub-Secrets (`EMAILPROXY_KEY`) — der Workflow
legt daraus das Firebase-Secret an. Ohne Workflow:

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
```

Eigene SMTP-Variablen braucht HabMail nicht mehr: Antworten und Weiterleiten
gehen über den Proxy, aus dem Postfach, in dem die Mail ankam. Alte
`SMTP_*`-Einträge in Vercel werden nicht mehr gelesen.

`api/mailboxes.ts` prüft das Firebase-Token des angemeldeten Nutzers und
schickt dessen UID als `subject` an den Proxy — genommen aus dem geprüften
Token, nie aus dem Request-Body. Ein Angemeldeter kann deshalb nicht die
Postfächer eines anderen anfragen.

## Benutzer und Postfächer

**Benutzer verwalten** (nur für Administratoren sichtbar): Konten anlegen,
Passwörter setzen, sperren, Adminrechte vergeben. Ein Konto zu löschen entfernt
auch dessen Mails und Ordner — die Postfächer im Proxy bleiben bestehen.

**Postfächer verwalten** (für jeden Benutzer, für seine eigenen):
**IONOS ist vorausgewählt**, Adresse und Passwort reichen — Server und Ports
sind hinterlegt (`smtp.ionos.de:587`, `imap.ionos.de:993`). Andere Anbieter
über die Auswahl; unter *Servereinstellungen ändern* lässt sich alles von Hand
überschreiben. Ohne IMAP-Server kann über das Postfach nur verschickt werden.

Bei Gmail und GMX braucht es ein App-Passwort, nicht das Kontopasswort.

## Bestand migrieren

Wer HabMail schon vor der Benutzertrennung benutzt hat, hat Mails flach an der
Wurzel der Datenbank liegen. In der App: *Benutzer verwalten* →
**Bestand übernehmen** → *Nachsehen* zeigt, was gefunden wurde, und erst der
zweite Knopf verschiebt etwas.

Dasselbe auf der Kommandozeile — die trägt zusätzlich den Administrator ein,
was für den allerersten Start nützlich ist:

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

## Buchhaltung

Zweite Ansicht neben dem Posteingang, oben rechts umschaltbar. Sie zeigt alles,
was als **Rechnung** oder **Mahnung** einsortiert wurde — gruppiert nach Monat,
mit Summe je Monat und dem laufenden Jahr.

Maßgeblich für den Monat ist das **Rechnungsdatum**, nicht der Eingang der Mail
(Feld `period`, aus `invoice.issuedOn` gebildet).

**Alle Rechnungen drucken** erzeugt *eine* PDF-Datei: vorne die Aufstellung
zum Abhaken, dahinter alle Belege. PDFs werden Seite für Seite übernommen,
Bilder als ganze Seite eingebettet. Anhänge, die sich nicht lesen lassen,
stehen danach als Hinweis da statt still zu fehlen.

Beträge und die Monatszuordnung lassen sich **antippen und korrigieren**. Das
ist Absicht: die KI liest nicht jede Rechnung richtig, und eine Summe, die man
nicht richtigstellen kann, taugt für die Steuer nichts. Die Datenbankregeln
erlauben deshalb Schreibzugriff auf `invoice` und `period` — aber nur im
eigenen Bereich.

`pdf-lib` wird erst beim Klick geladen (eigener Chunk, ~420 kB); der Start der
App bleibt davon unberührt.

## Bankumsätze

Optional — ohne bleibt die Buchhaltung voll nutzbar, es fehlt dann nur die
Angabe, ob eine Rechnung bezahlt ist. Überweisen kann HabMail in keinem Fall
etwas; Umsätze werden ausschließlich gelesen.

Es gibt zwei Wege zu denselben Daten.

### Weg 1: Kontoauszug einlesen (empfohlen)

Braucht nichts außer der Datei aus dem Online-Banking. Kein Anbieter, kein
Vertrag, kein Tageslimit, keine 90-Tage-Frist.

1. Im Online-Banking die Umsätze exportieren — **CSV**, **CAMT.053 (XML)** oder
   **MT940**. Jede deutsche Bank bietet mindestens eines davon an.
2. In der App: **Buchhaltung → Bankumsätze → Datei auswählen**.

Das Format wird am Inhalt erkannt, nicht an der Endung. Die Spaltennamen der
gängigen deutschen Banken sind hinterlegt (Sparkasse, VR, DKB, Commerzbank,
ING …); Vorspann-Zeilen vor der eigentlichen Tabelle werden übersprungen, ebenso
ISO-8859-1 statt UTF-8 und Beträge in beiden Schreibweisen.

Jede Buchung bekommt eine Kennung, die sich aus ihren Daten ergibt. **Denselben
Auszug noch einmal einzulesen ist deshalb harmlos** — was schon da ist, wird
erkannt und nicht doppelt verbucht; die Rückmeldung nennt die Zahl. Auch
überlappende Zeiträume sind damit unproblematisch, und eine bereits bestätigte
Zuordnung geht beim erneuten Einlesen nicht verloren.

Der Leser steht in [`functions/statement.js`](functions/statement.js) und hängt
weder an Firebase noch an einem Anbieter.

### Weg 2: automatisch über GoCardless

**GoCardless Bank Account Data nimmt seit Juli 2025 keine neuen Konten mehr
an.** Wer bereits Zugangsdaten hat, kann sie weiter nutzen — für alle anderen
ist Weg 1 der gangbare. Der Code bleibt vollständig erhalten.

1. `GOCARDLESS_SECRET_ID` und `GOCARDLESS_SECRET_KEY` als GitHub-Secrets
   anlegen, Workflow laufen lassen.
2. In der App: **Buchhaltung → Bankumsätze → Bank automatisch verbinden**, Bank
   suchen, bei der Bank anmelden. Danach landest du wieder in HabMail und die
   Umsätze werden geholt, ab dann täglich um 6:30 Uhr.

Ohne hinterlegte Zugangsdaten melden sich die betreffenden Aufrufe mit einem
Hinweis auf Weg 1, statt still nichts zu tun.

### Wie zugeordnet wird

Gleich, egal woher der Umsatz kam — ab dem Abgleich unterscheidet HabMail die
beiden Wege nicht mehr.

Der Betrag muss **exakt** stimmen, sonst gibt es gar keinen Kandidaten. Punkte
vergeben nur die Belege dafür, dass es dieselbe Sache ist: Rechnungsnummer im
Verwendungszweck (+3), passender Empfänger (+2), Zahlung innerhalb von 30 Tagen
nach Rechnungsdatum (+1).

**Automatisch** zugeordnet wird nur, wenn es genau einen Kandidaten mit
mindestens 3 Punkten gibt und kein zweiter gleichauf liegt. Alles andere landet
unter *Zahlungen prüfen* — eine falsche automatische Zuordnung ist in der
Buchhaltung schlimmer als eine, die man selbst anklickt. Jede Zuordnung lässt
sich wieder lösen.

### Grenzen

Für beide Wege:

- Umsätze und der Rechnungsindex sind für den Browser **nur lesbar**;
  geschrieben wird ausschließlich serverseitig.
- Nur **Ausgänge** können eine Rechnung bezahlen. Ein Zahlungseingang wird
  gespeichert, aber nie einer Eingangsrechnung zugeordnet.

Nur beim Auszug:

- **Höchstens 5 MB je Datei** — die Datei geht Base64-kodiert durch eine
  Callable, und die nimmt 10 MB. Ein Jahr Umsätze wiegt als CSV keine 300 kB.
- Eingelesen wird, was im Auszug steht. Neue Umsätze kommen nicht von selbst
  dazu; das ist der Preis dafür, dass es keinen Anbieter braucht.

Nur bei GoCardless:

- **Vier Abrufe pro Konto und Tag.** Einer geht an den geplanten Lauf um
  6:30 Uhr, drei bleiben für *Jetzt abgleichen*.
- **Die Zustimmung läuft nach 90 Tagen ab** (PSD2). In der Kontoliste steht,
  wie lange sie noch gilt; danach ist eine erneute Anmeldung bei der Bank nötig.
- **Meist nur 90 Tage Historie** beim ersten Verbinden.
- Bei einem **Firmenkonto** ist der Kontoinhaber die Firma, nicht die Person,
  die HabMail bedient. Ein Zugang für fremde Konten setzt die Zustimmung der
  Firma voraus — das ist keine technische, sondern eine rechtliche Grenze.

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
- **Anhänge über 1 MB fehlen im Sammel-PDF.** Sie liegen gar nicht erst in der
  Datenbank (siehe oben). Bis die Dateien nach Firebase Storage umziehen, muss
  man sie für den Steuerberater von Hand aus der Mail holen — das Deckblatt
  weist darauf hin.
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
