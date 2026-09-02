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
   Rechnungen zusätzlich Nummer, Betrag, Datum und Fälligkeit. **Angehängte
   PDFs und Bilder gehen mit** (bis zu drei je Mail, siehe unten): bei „anbei
   unsere Rechnung" steht der Betrag dort und in keiner Zeile Mailtext.
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

## Ältere Mails nachholen

Das Abholen geht vorwärts: beim ersten Mal die letzten 25 Mails, danach nur
noch, was neu dazukommt. Alles, was vorher im Postfach lag, bleibt damit
draußen — bei einem Buchhaltungs-Posteingang ausgerechnet der Teil mit den
Rechnungen des laufenden Jahres.

Dafür gibt es in *Postfächer* den Abschnitt **Ältere Mails nachholen**:

1. Datum wählen (z.B. 1. Januar des laufenden Jahres) und **Nachsehen**. Das
   zählt nur — es wird keine einzige Mail übertragen. Angezeigt wird je
   Postfach, wie viele Mails offen sind und wie viele Megabyte das sind.
2. **Nachholen** startet. Gearbeitet wird von der jüngsten Mail des Zeitraums
   rückwärts, in Abschnitten von einigen Minuten; der Fortschritt steht
   daneben. **Anhalten** geht jederzeit, ein neuer Start macht dort weiter.

Zwei Dinge sind dabei wichtig:

- **Anhänge kommen standardmäßig nur bei Rechnungen und Mahnungen mit.** Bei
  allen anderen Mails wird der Anhang mit Namen und Größe vermerkt und bleibt
  im Postfach. Der Grund steht in der Mail. Gemessen an einem echten
  Posteingang: 15 Mails enthielten knapp 8 MB Anhänge, ein ganzes Jahr wären
  dreiviertel Gigabyte — und die App lädt den Posteingang beim Öffnen am
  Stück. Wer trotzdem alles will, setzt den Haken „Alle Anhänge übernehmen".
  Die KI liest die PDFs übrigens in beiden Fällen, Betrag und Rechnungsdaten
  stehen also so oder so im Datensatz.
- **Der laufende Abruf bleibt unberührt.** Nachlauf und Fünf-Minuten-Lauf
  führen im Email-Proxy getrennte Wasserstände; der eine zählt hoch, der
  andere runter.

Mails, die schon in HabMail liegen, werden beim Nachholen erkannt und
übersprungen — ohne KI-Aufruf und ohne zweite Übergabe ans Rechnungsprogramm.

> Das braucht einen Email-Proxy, der `since` beim Abholen kennt. Ältere Stände
> antworten darauf mit „nichts Neues", und der Nachlauf findet nichts.

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

### Übergabe ans Rechnungsprogramm

Rechnungen und Mahnungen können weiter in die Buchhaltung des
[Rechnungsprogramms](https://github.com/Christof999/Timo_Rechnungsprogramm)
laufen. Dort werden sie zu Eingangsrechnungen — mit Lieferant, Nummer, Betrag,
Fälligkeit und den angehängten Belegen.

Neue Mails gehen beim Abholen von allein hinüber. Für den Bestand gibt es in
der Buchhaltung den Knopf **Buchhaltung übergeben**; er arbeitet seitenweise
und lässt sich jederzeit wiederholen — drüben ist die Mail-Kennung zugleich die
Dokument-Kennung, es entsteht also nichts doppelt. Was dort schon bearbeitet
wurde (Status, Freigabe, Kategorie, Notizen), bleibt dabei unangetastet.

Eingerichtet wird das über drei Werte in den Functions (im Deploy-Workflow als
Secret bzw. Variables, siehe Kopf von `.github/workflows/firebase-deploy.yml`):

| Wert | Wo | Bedeutung |
|---|---|---|
| `RECHNUNGSPROGRAMM_URL` | Variable | Adresse des Rechnungsprogramms, z. B. `https://…vercel.app` |
| `RECHNUNGSPROGRAMM_TOKEN` | Secret | gemeinsames Passwort; drüben `HABMAIL_WEBHOOK_TOKEN` |
| `RECHNUNGSPROGRAMM_UID` | Variable | Firebase-UID **des** Benutzers, dessen Buchhaltung übergeben wird |
| `RECHNUNGSPROGRAMM_MAILBOXES` | Variable, optional | Postfach-Kennungen mit Komma; leer = alle Postfächer dieses Benutzers |

Die UID ist Absicht und kein Beiwerk: HabMail bedient mehrere Firmen, und ohne
sie wüsste niemand, wessen Rechnungen gemeint sind. Fehlt einer der drei Werte,
wird **nichts** übergeben — auch nicht versehentlich die Post einer anderen
Firma.

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

## Schreiben

Antworten und Weiterleiten laufen über den Email-Proxy, aus dem Postfach heraus,
in dem die Mail ankam. **Einzurichten ist dafür nichts** — es sind dieselben
Zugangsdaten wie beim Empfangen.

- **Neue E-Mail** über den Knopf oben rechts, neben dem Kontozeichen. Ohne Bezug
  auf eine vorhandene Mail und deshalb ohne Zitat; auf dem Handy nur das
  Stiftzeichen, weil in der Kopfzeile schon Menü, Titel und Konto stehen.
- **Absender wählen.** Ab zwei Postfächern steht im Schreibfenster ein Feld
  „Von“, vorbelegt mit dem Postfach der Mail.
- **Signaturen**, eine je Postfach, unter *Kontozeichen → Signaturen*. Sie steht
  sichtbar im Schreibfeld und lässt sich dort noch anpassen; beim Wechsel des
  Absenders wird die alte ersetzt, nicht die neue angestapelt.
- **Bild in der Signatur** (Logo), je Postfach eines: PNG, JPEG, GIF oder WebP
  bis 200 kB. Es geht **als eingebetteter Anhang mit einer Content-ID** mit, und
  die Mail bekommt dafür eine HTML-Fassung mit `<img src="cid:…">`. Als
  `data:`-Adresse ginge es nicht — Gmail und Outlook entfernen solche Bilder
  wortlos, beim Absender sieht die Mail trotzdem gut aus. Ohne Bild bleibt die
  Mail reiner Text wie bisher; der Text reist auch mit Bild immer mit.
- **Anhänge**: bis zu 10 Dateien, zusammen 3 MB. Mehr nimmt eine Vercel-Function
  nicht an — Base64 bläht die Bytes um ein Drittel auf.

### Wer als Absender erscheint

Für Postfächer **mit Eigentümer** — also die je Benutzer angelegten — gilt:
`from` am Postfach, sonst der SMTP-Benutzer (bei IONOS und Strato ist das die
Mailadresse selbst), sonst der Absender am Client, sonst `MAIL_FROM`.

Das Postfach steht bewusst vorn. Diese Postfächer melden sich mit ihren eigenen
Zugangsdaten beim Mailserver an, und der lehnt einen fremden Absender ab:

```
550 5.7.0 Die verwendete Absenderadresse im Envelope-From
(info@soergel-design.de) gehoert nicht zu Ihrem authentifizierten
STRATO Paket (info@fliesen-reisloehner.de)
```

Für Postfächer **ohne Eigentümer** bleibt es bei der alten Reihenfolge — Client,
Postfach, `MAIL_FROM`. Andere Projekte hängen daran, daran wird nichts geändert.

## Mehrere Firmen

Wer mehrere Firmen führt, braucht die Buchhaltung je Firma getrennt — jede gibt
ihre eigene Steuererklärung ab. Angelegt werden Firmen unter **Buchhaltung →
Firmen**.

Woran erkennt HabMail die Firma? Zwei Wege, in dieser Reihenfolge
([`src/companies.ts`](src/companies.ts)):

1. **Am Postfach.** Hat jede Firma ihr eigenes, ist das keine Vermutung, sondern
   eine Tatsache: die Mail ist dort angekommen. Kostenlos, sofort, immer gleich.
   Deshalb zuerst — dafür ordnet man einer Firma ihre Postfächer zu.
2. **Am Rechnungsempfänger aus dem Beleg.** Nötig bei einem gemeinsamen
   Buchhaltungspostfach, in dem Rechnungen mehrerer Firmen landen: dann sagt das
   Postfach nichts. Die KI liest den Namen aus dem Anschriftenfeld des PDFs
   (`invoice.recipient`), und der wird gegen die Firmennamen gehalten. **Ein
   Postfach, das keiner Firma zugeordnet ist, geht automatisch diesen Weg.**

Für Weg 2 gibt es je Firma *weitere Schreibweisen* — „Lauffer Bau", „Lauffer Bau
GmbH & Co. KG". Verglichen wird ohne Rechtsform, Umlaute und Groß-/Kleinschreibung.
**Passen zwei Firmen, wird gar nichts zugeordnet**: eine falsche Firma in der
Steuer ist schlimmer als eine, die man selbst zuordnet.

Widersprechen sich beide Wege — Rechnung im Postfach von Firma A, adressiert an
Firma B —, **gewinnt das Postfach**, und die Zeile trägt einen roten Hinweis.
Meist ist die Rechnung schlicht im falschen Postfach gelandet.

In der Buchhaltung heißt das: der **Monat bleibt die erste Ebene** (die Steuer
läuft nach Zeitraum), die Firma kommt darunter — mit eigener Summe und eigenem
PDF-Stapel, der den Firmennamen auf dem Deckblatt und im Dateinamen trägt. Über
den Auswahlknöpfen oben lässt sich auf eine einzige Firma einschränken.

**Zugeordnet wird beim Anzeigen, nicht beim Ablegen.** Eine Umbenennung oder ein
umgehängtes Postfach wirkt sofort auf den gesamten Bestand; es muss nichts
nachgezogen werden. Wer keine Firma anlegt, merkt von alledem nichts — dann
verhält sich die Buchhaltung wie zuvor.

## Was die KI zu sehen bekommt

[`functions/categorize.js`](functions/categorize.js) schickt an Gemini: Absender,
Betreff, Mailtext (6.000 Zeichen) **und die lesbaren Anhänge als Datei**.

Ohne die Anhänge geht es nicht. Eine typische Rechnungsmail lautet „anbei unsere
Rechnung, mit freundlichen Grüßen" — Betrag, Nummer und Datum stehen
ausschließlich im PDF. Wer nur den Text schickt, bekommt keinen Betrag zurück,
und die Buchhaltung zeigt 0,00 €.

Mitgeschickt werden PDF, PNG, JPEG, WebP, HEIC und HEIF. Ist der Anhang als
`application/octet-stream` deklariert — das machen viele Mailprogramme —,
entscheidet die Dateiendung. Grenzen: höchstens **3 Anhänge** je Mail, **4 MB**
je Stück, **8 MB** zusammen. Word- und Excel-Dateien gehen nicht mit; sie werden
gespeichert, aber nicht ausgewertet.

**Der Inhalt der Anhänge geht auch in die Zusammenfassung**, nicht nur in die
Rechnungsfelder. Die Leitfrage lautet: „muss ich das PDF öffnen?" — wer die
Zusammenfassung liest, soll Beträge, Mengen und Fristen kennen. Steht im
Mailtext nur „anbei unsere Rechnung", kommt die Zusammenfassung vollständig aus
dem Anhang; „im Anhang befindet sich eine Rechnung" ist ausdrücklich untersagt.

Ob das geklappt hat, steht an jeder Mail unter der Zusammenfassung:
*„Zusammenfassung samt 2 Anhängen"* oder *„nur aus dem Mailtext — kein Anhang
war lesbar"*. Bei Mails von vor dieser Zählung steht dort nichts, statt etwas
Falsches zu behaupten.

Bei Widersprüchen zwischen Mailtext und Anhang zählt der Anhang. Als Betrag ist
ausdrücklich der **Bruttogesamtbetrag** verlangt, nicht netto und nicht eine
einzelne Position. Neben dem Aussteller (`vendor`) wird auch der
**Rechnungsempfänger** (`recipient`) gelesen — die eigene Firma, an die die
Rechnung adressiert ist. Den braucht die Zuordnung bei mehreren Firmen.

### Bestand nachträglich auswerten

Bis August 2026 gingen die Anhänge **nicht** mit — daher Rechnungen ohne Betrag.
Der Fehler ist behoben, aber alte Datensätze rechnen sich nicht von selbst neu.

**Buchhaltung → Rechnungen neu auswerten.** Der Knopf erscheint, sobald es
Rechnungen ohne Betrag gibt, und steht auch in der leeren Buchhaltung — sind
Rechnungen als *Sonstiges* gelandet, ist die Liste ja gerade leer.

Angefasst wird nur, was einen lesbaren Anhang hat **und** bei dem etwas fehlt:
als Rechnung erkannt, aber ohne Betrag; oder nicht als Rechnung erkannt und ohne
Betrag. Eine vollständige Rechnung wird nicht noch einmal durchgerechnet — das
kostet nur Geld und würde von Hand korrigierte Zahlen überschreiben. Zugeordnete
Zahlungen bleiben ebenfalls unangetastet: `invoice` wird feldweise ergänzt, nicht
ersetzt.

[`functions/reanalyze.js`](functions/reanalyze.js) arbeitet **seitenweise** (8
Mails je Aufruf) und gibt einen Cursor zurück; die Oberfläche ruft so lange auf,
bis `done` kommt. Eine Mail mit PDF wiegt schnell ein Megabyte — ein Jahr
Posteingang passt weder in den Speicher der Function noch in ihr Zeitbudget.

Anhänge über `MAX_INLINE_ATTACHMENT_BYTES` (Standard 1 MB) liegen gar nicht in
der Datenbank und lassen sich deshalb auch nicht nachträglich auswerten. Für die
kommen die Beträge nur über *Betrag korrigieren* herein.

## Läuft das automatische Abholen?

**Der Deploy-Workflow hat damit nichts zu tun.** Er rollt Code aus. Wer ihn
laufen lassen muss, damit Mails ankommen, hat kein Deploy-Problem, sondern einen
fehlenden Zeitplan — beim Ausrollen werden die Functions neu gestartet, und
dabei läuft das Abholen einmal nebenbei mit. Das ist ein Nebeneffekt, kein Weg.

Jeder Lauf hinterlässt seinen Stand unter `users/<uid>/pollStatus` — Zeitpunkt,
Auslöser, Zahlen, Fehler. Serverseitig geschrieben, für den Browser nur lesbar.
Zu sehen unter **Postfächer**, oben:

| Anzeige | Bedeutung |
| --- | --- |
| **automatisch**, vor wenigen Minuten | Der Cloud Scheduler läuft. Alles gut. |
| **automatisch (GitHub)** | Der Ersatztakt läuft (siehe unten). Auch gut. |
| nur **von Hand**, oder alt | Es taktet nichts. Ursache unten. |
| **fehlgeschlagen** | Die Meldung kommt vom Email-Proxy und nennt den Grund. |

### Wer den Zeitplan anlegt

`firebase deploy --only functions` **soll** für jede `onSchedule`-Function einen
Cloud-Scheduler-Job anlegen. Von Hand ist da nichts zu tun. Nur misslingt das
still, wenn dem Dienstkonto Rechte fehlen: das Ausrollen meldet Erfolg, der Job
fehlt, und zu merken ist es allein daran, dass keine Mails ankommen.

Der Grund liegt in der 2. Generation der Functions: die laufen auf Cloud Run, und
der Zeitplan ruft sie über HTTP auf. Damit er das darf, muss beim Ausrollen dem
Dienstkonto des Zeitplans das Recht *Cloud Run-Aufrufer* eingetragen werden — und
das darf nur, wer selbst **Cloud Run-Administrator** ist. Fehlt die Rolle, wird
der Job nicht angelegt, ohne dass irgendwo ein Fehler steht.

Deshalb prüft der Deploy-Workflow im Schritt **„Zeitplan sicherstellen"** nach
und **legt den Job notfalls selbst an**
([`.github/scripts/ensure-schedule.mjs`](.github/scripts/ensure-schedule.mjs)).
Er nimmt dabei bewusst einen anderen Weg als Firebase: statt auf `pollMailboxes`
zu zeigen — was *Cloud Run-Aufrufer* voraussetzt — zeigt er auf
`pollMailboxesNow` und weist sich über `POLL_TRIGGER_TOKEN` aus. Damit genügt die
Rolle **Cloud Scheduler-Administrator**, und die fehlende Cloud-Run-Rolle spielt
keine Rolle mehr.

Was der Schritt im Protokoll sagt:

| Meldung | Bedeutung |
| --- | --- |
| `Zeitplan aktiv: …` | Alles in Ordnung, nichts zu tun. |
| `Zeitplan … angelegt` | Firebase hatte ihn nicht angelegt, der Workflow schon. Erledigt. |
| `Zum Anlegen fehlt POLL_TRIGGER_TOKEN` | Das Secret setzen und noch einmal ausrollen. |
| `dem Dienstkonto fehlt die Rolle Cloud Scheduler-Administrator` | Rolle vergeben, oder den Ersatztakt unten nehmen. |

Ein pausierter Job wird wieder gestartet, und gesucht wird in allen Regionen —
nicht nur in `europe-west1`, damit „ich finde ihn nicht" keine falsche Diagnose
wird.

Wer beide Rollen vergeben kann, sollte es trotzdem tun (**Cloud
Run-Administrator** und **Cloud Scheduler-Administrator** unter IAM): dann legt
Firebase den Job wieder selbst an, und der Umweg entfällt.

### Ersatztakt ganz ohne Google

Scheitert auch das Anlegen, taktet
[`.github/workflows/poll-mailboxes.yml`](.github/workflows/poll-mailboxes.yml)
das Abholen von GitHub aus: alle fünf Minuten ein Aufruf von
`pollMailboxesNow`. Einschalten heißt, `POLL_TRIGGER_TOKEN` als Secret zu setzen
und einmal auszurollen — mehr nicht.

Zwei Einschränkungen, die der Cloud Scheduler nicht hat: GitHub hält Zeitpläne
nicht genau ein (aus fünf Minuten werden unter Last auch zwanzig), und **es
schaltet sie ab, wenn 60 Tage lang niemand etwas ins Repository schiebt** —
danach genügt ein Klick auf *Enable workflow*. Der zweitbeste Weg, aber ein
funktionierender.

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

- **Anhänge liegen als Base64 in der Realtime Database.** Zum Öffnen und
  Speichern baut [`src/attachments.ts`](src/attachments.ts) daraus einen Blob;
  `data:`-Adressen gingen auf dem Handy nicht (siehe Kommentar dort). Das trägt
  aber nicht weit:
  der Client lädt beim Start den ganzen Baum. Dateien über 1 MB werden deshalb
  schon jetzt nur mit Namen und Größe gespeichert
  (`MAX_INLINE_ATTACHMENT_BYTES`). Für ein echtes Belegarchiv gehören sie nach
  Firebase Storage.
- **Anhänge über 1 MB fehlen im Sammel-PDF**, lassen sich nicht öffnen und auch
  nicht nachträglich auswerten. Sie liegen gar nicht erst in der Datenbank
  (siehe oben). Beim Abholen sieht die KI sie noch — der Proxy liefert bis 2 MB
  —, aber danach findet sie niemand mehr. In der Mail steht dann, warum; bis die
  Dateien nach Firebase Storage umziehen, muss man sie von Hand aus dem Postfach
  holen.
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
