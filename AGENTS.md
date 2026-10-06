# HabMail für KI-Agenten

HabMail lässt sich von KI-Agenten bedienen. **Wer einen Browser hat, braucht
dafür nichts einzurichten — keinen Key, keine Umgebungsvariable.** Der Agent
meldet sich an wie ein Mensch und arbeitet als dieser Nutzer.

| Weg | Wofür | Einrichtung |
|---|---|---|
| 1. `window.habmail` | Agent, der einen Browser fernsteuert | keine |
| 2. Oberfläche anklicken | Screenshot- und Klick-Agenten | keine |
| 3. HTTP mit Agent-Key | Agent ohne Browser: Auftrag im Hintergrund, n8n, Cron, Skript, MCP im Chat | Key in Vercel |

Verschickt wird immer über den [Email-Proxy](https://github.com/Christof999/Emailproxy)
aus einem Postfach des jeweiligen Nutzers. Die Wege 1 und 2 handeln als der
angemeldete Nutzer und können deshalb nichts, was er nicht auch von Hand
könnte. Nur Weg 3 braucht einen Key — dort ist ja niemand angemeldet, den man
fragen könnte.

---

## 1. `window.habmail` — ohne Key, im Browser

Sobald die Seite geladen ist, hängt dort eine kleine API. Damit muss der Agent
keine Felder im Accessibility-Tree suchen — genau daran scheitern
Browser-Agenten sonst: sie sehen den Knopf, aber nicht das Formular dahinter.
Sie ist schon **vor** der Anmeldung da.

```js
// Warten, bis die API da ist:
await new Promise((r) =>
  window.habmail ? r() : window.addEventListener('habmail:ready', r, { once: true }),
)

window.habmail.describe()   // Selbstbeschreibung, UID, alle Methoden
window.habmail.isSignedIn() // false → erst anmelden:
await window.habmail.signIn('mitarbeiter@firma.de', '…')

// Mail schreiben und verschicken — ohne einen einzigen Klick:
await window.habmail.sendMail({
  to: 'christof.didi@googlemail.com',
  subject: 'Testbetreff',
  body: 'Hallo,\n\nhier der Text.',
  dryRun: true,   // erst prüfen, dann ohne dryRun echt senden
})

// Oder nur vorbereiten und den Menschen senden lassen:
window.habmail.openCompose({ to: '…', subject: '…', body: '…' })

// Posteingang lesen und antworten:
window.habmail.listMails({ limit: 10, query: 'rechnung' })
window.habmail.getMail('<id>')
await window.habmail.listMailboxes()
await window.habmail.replyTo('<id>', 'Danke, passt so.')

// Kalender der angemeldeten Person:
await window.habmail.listEvents({ from: '2026-10-05', to: '2026-10-12' })
await window.habmail.createEvent({
  title: 'Baustelle Müller',
  start: '2026-10-06T14:00',   // ohne Zone: Zeit des Geräts; nur ein Datum = ganztägig
  end: '2026-10-06T15:30',
  location: 'Hauptstr. 3',
  reminders: [1440, 60, 10],   // Push: Vortag, eine Stunde, zehn Minuten
  dryRun: true,                 // nennt nur, womit es sich überschneidet
})
window.habmail.openEvent({ title: '…', start: '…' })  // Formular öffnen, Mensch speichert
await window.habmail.deleteEvent('<id>')
```

Ohne `mailboxId` verschickt `sendMail` aus dem ersten Postfach, `replyTo` aus
dem, in dem die Mail ankam. `signIn` tut dasselbe wie der Knopf „Anmelden";
die Zugangsdaten gehen direkt an Firebase und werden nirgends
zwischengespeichert. `document.documentElement.dataset.habmailAgentApi`
enthält die Version, sobald die API bereitsteht.

---

## 2. Oberfläche anklicken — ebenfalls ohne Key

Wer lieber klickt, findet stabile Anker. Sie sind unabhängig von der
Beschriftung, die sich ändern kann.

| Element | Anker |
|---|---|
| Anmeldung | `#login-email`, `#login-password`, `[data-testid="login-submit"]`, Fehler in `[data-testid="login-error"]` |
| Neue Mail öffnen | `[data-testid="compose-new"]`, Tastenkürzel `n` |
| Dialog | `[data-testid="send-mail-dialog"]` (`data-compose-mode` = new/reply/forward) |
| Absender-Postfach | `#send-mail-from` (nur ab zwei Postfächern) |
| Empfänger | `#send-mail-to` / `[data-testid="send-mail-to"]` |
| Betreff | `#send-mail-subject` / `[data-testid="send-mail-subject"]` |
| Nachricht | `#send-mail-body` / `[data-testid="send-mail-body"]` |
| Anhänge | `#send-mail-attachments` |
| Senden | `[data-testid="send-mail-submit"]` |
| Abbrechen | `[data-testid="send-mail-cancel"]`, sonst `Escape` |
| Fehlermeldung | `[data-testid="send-mail-error"]` (`role="alert"`) |

Antworten und Weiterleiten hängen an den Knöpfen „Antworten" und
„Weiterleiten" der jeweiligen Mail-Karte (`aria-label`).

Der Kalender:

| Element | Anker |
|---|---|
| Ansicht öffnen | `[data-testid="view-calendar"]` |
| Neuer Termin | `[data-testid="calendar-new"]` |
| Formular | `[data-testid="calendar-event-dialog"]` |
| Titel, Ort, Notiz | `[data-testid="calendar-event-title"]`, `…-location`, `…-notes` |
| Beginn, Ende | `[data-testid="calendar-event-start-date"]`, `…-start-time`, `…-end-date`, `…-end-time` |
| Ganztägig, Erinnerung | `[data-testid="calendar-event-allday"]`, `[data-testid="calendar-event-reminder"]` |
| Überschneidung | `[data-testid="calendar-event-conflict"]` (`role="status"`) |
| Speichern, Löschen | `[data-testid="calendar-event-save"]`, `[data-testid="calendar-event-delete"]` |
| Ein Termin in der Liste | `[data-testid="calendar-event"]` (`data-event-id`) |

---

## 3. HTTP mit Agent-Key — für Agenten ohne Browser

Nur nötig, wenn niemand angemeldet ist: ein Auftrag, der nachts läuft, ein
n8n-Ablauf, ein Skript. Im Browser ist Weg 1 der einfachere.

### Einrichten (einmalig, durch den Betreiber)

Gebraucht werden drei Dinge: ein Key, die eigene Firebase-UID und die ID des
Absender-Postfachs.

```bash
# Key erzeugen — die Ausgabe gehört in keine versionierte Datei
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

UID und Postfächer stehen in der angemeldeten App in der Browser-Konsole:

```js
window.habmail.describe().uid        // die eigene Firebase-UID
await window.habmail.listMailboxes() // [{ id: 'habmail-…', from: '…' }]
```

Damit in Vercel unter **Settings → Environment Variables** (Production *und*
Preview) `HABMAIL_AGENT_KEYS` als JSON-Array setzen und neu deployen:

```json
[
  {
    "id": "openclaw",
    "key": "<mindestens 24 Zeichen>",
    "uid": "<Firebase-UID>",
    "mailbox": "<Postfach-ID>",
    "allowedTo": ["christof.didi@googlemail.com", "@meine-firma.de"]
  }
]
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `key` | ja | Das Geheimnis, mindestens 24 Zeichen. Kürzere Einträge werden ignoriert. |
| `uid` | ja | Firebase-UID des Eigentümers. Ohne sie lässt der Proxy kein Postfach zu. Sie kommt **nur** aus dem Key, nie aus dem Aufruf. |
| `id` | nein | Name des Agenten, taucht im Manifest und im Protokoll auf. |
| `mailbox` | nein | Vorgabe für den Absender, wenn der Aufruf keinen nennt. |
| `allowedTo` | nein | Erlaubte Empfänger: Adressen oder ganze Domains als `@firma.de`. Leer = alle. |

Ohne `HABMAIL_AGENT_KEYS` ist der Agent-Zugang komplett aus, und die App
verhält sich wie bisher.

### Benutzen

```bash
# Erst trocken — es geht nichts raus:
curl -sS https://hab-mail.vercel.app/api/send-mail \
  -H "X-HabMail-Agent-Key: $HABMAIL_AGENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "kind": "new",
        "to": "christof.didi@googlemail.com",
        "subject": "Testbetreff",
        "body": "Hallo,\n\nhier der Text.\n\nViele Grüße",
        "dryRun": true
      }'
```

Bei `dryRun` kommt die fertige Mail zurück (`text`, `mailbox`, `to`,
`subject`), verschickt wird nichts. Ohne `dryRun` antwortet der Server mit
`{ "ok": true, "mailbox": …, "from": … }` — der Adresse, von der es
tatsächlich ging.

Der Key darf auch als `Authorization: Bearer <key>` kommen; alles, was kein
JWT ist, wird als Agent-Key gelesen.

### Als MCP-Server im Chat

Derselbe Key öffnet auch `/api/mcp` — damit hängt HabMail als Werkzeug in
Claude Code oder Codex, statt dass der Agent curl-Aufrufe baut:

```bash
claude mcp add --transport http habmail https://hab-mail.vercel.app/api/mcp \
  --header "Authorization: Bearer $HABMAIL_AGENT_KEY"
```

| Werkzeug | Zweck |
|---|---|
| `habmail_overview` | Postfächer des Eigentümers, Vorgabe-Postfach, erlaubte Empfänger |
| `send_mail` | Dieselben Felder wie unten. **Hier ist `dryRun` die Vorgabe** — verschickt wird erst mit `dryRun: false` |

Der Endpunkt reicht den Versand an `/api/send-mail` weiter; `allowedTo` und
alle Fehler gelten unverändert. Eine Signatur hängt HabMail auf diesem Weg
nicht an, sie gehört in den Text. Was rausging, holt der nächste Abruf aus
dem Postfach in den Ordner „Gesendet".

Dazu der Kalender der Person, der der Key gehört:

| Werkzeug | Zweck |
|---|---|
| `list_events` | Termine in einem Zeitraum, ohne Angabe die nächsten 14 Tage |
| `find_free_time` | Freie Zeiten an Werktagen — für einen Terminvorschlag an den Kunden |
| `create_event` | Termin eintragen. Die Antwort nennt Überschneidungen; `dryRun: true` prüft nur |
| `update_event`, `delete_event` | Ändern und löschen, über die `id` aus `list_events` |

Zeiten ohne Zone sind Berliner Zeit, ein Datum ohne Uhrzeit ist ein ganzer
Tag. `reminders` schickt Push-Nachrichten aufs Telefon, eine je Zeitpunkt
(Minuten vor dem Beginn); `reminderMinutes` ist die einzelne Erinnerung.

Anhänge nimmt `send_mail` nur als Base64 im Aufruf. Für Bilder und Dokumente
von der Platte gibt es deshalb ein Skript, das die Dateien selbst liest und
denselben Key benutzt — ohne `--send` ein Probelauf:

```bash
node scripts/habmail-send.mjs --to kunde@firma.de --subject "Angebot" \
  --body-file text.txt --attach angebot.pdf --attach foto.jpg --send
```

### Felder

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `kind` | nein | `new` (frei verfasst), `reply`, `forward`. Standard: `reply` |
| `to` | ja | Empfänger, mehrere per Komma |
| `subject` | ja | Betreff, max. 500 Zeichen |
| `body` | ja | Klartext |
| `mailboxId` | nein | Absender-Postfach; ohne Angabe das im Key hinterlegte |
| `attachments` | nein | `[{ filename, contentType, contentBase64 }]`, zusammen bis 3 MB |
| `context` | nur `reply`/`forward` | `{ originalFrom, originalSubject, originalBody }` — wird zitiert angehängt |
| `dryRun` | nein | `true` = nur zusammenbauen, nichts verschicken |

`GET /api/send-mail` liefert dieselbe Beschreibung als JSON — der erste
Aufruf für einen Agenten, der die Schnittstelle noch nicht kennt.
`GET /api/mailboxes` (mit Firebase-Token) listet die Postfächer.

### Fehler

`invalid_agent_key`, `recipient_not_allowed` (nicht in `allowedTo`),
`no_mailbox` (kein Absender-Postfach), `bad_request` (Empfänger oder Betreff
fehlt), `attachments_too_large`, `proxy_not_configured`, `proxy_unreachable`.
Bei 5xx lohnt ein Retry, bei 4xx nicht.

---

## Regeln

- **Im Browser braucht es keinen Key.** Wer einen setzt, ohne ihn zu
  brauchen, schafft nur ein weiteres Geheimnis, das lecken kann.
- **Keys gehören in Environment-Variablen**, nie in Quelltext, Beispiele oder
  Commit-Nachrichten.
- **Pro Agent ein eigener Key** — dann lässt sich einer sperren, ohne die
  anderen abzuschalten.
- **Vor dem ersten echten Versand `dryRun`.**
- **`allowedTo` setzen**, wenn feststeht, wohin gesendet wird. Ein Key, der
  nur an eine Adresse senden darf, ist im Ernstfall harmlos.
