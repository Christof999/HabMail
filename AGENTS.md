# HabMail für KI-Agenten

HabMail lässt sich von KI-Agenten bedienen, ohne dass sie sich durch die
Oberfläche klicken müssen. Drei Wege — der erste ist der zuverlässigste.

| Weg | Wofür | Als wer |
|---|---|---|
| 1. HTTP mit Agent-Key | Agent ohne Browser (OpenClaw-Auftrag, n8n, Cron, Skript) | Der Nutzer, dessen UID im Key steht |
| 2. `window.habmail` | Agent, der die geöffnete App fernsteuert | Der angemeldete Nutzer |
| 3. Oberfläche anklicken | Screenshot- und Klick-Agenten | Der angemeldete Nutzer |

Verschickt wird immer über den [Email-Proxy](https://github.com/Christof999/Emailproxy)
aus einem Postfach des jeweiligen Nutzers. Der Proxy prüft dabei, wem das
Postfach gehört — deshalb trägt jeder Agent-Key die Firebase-UID seines
Eigentümers. **Ein Key steht für einen Nutzer, nicht für die App.**

---

## 1. HTTP mit Agent-Key (empfohlen)

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

## 2. `window.habmail` im geöffneten Browser

Sobald die App geladen ist, hängt dort eine kleine API. Damit muss der Agent
keine Felder im Accessibility-Tree suchen — genau daran scheitern
Browser-Agenten sonst.

```js
// Warten, bis die API da ist:
await new Promise((r) =>
  window.habmail ? r() : window.addEventListener('habmail:ready', r, { once: true }),
)

window.habmail.describe()   // Selbstbeschreibung, UID, alle Methoden
window.habmail.isSignedIn() // false → der Mensch muss sich erst anmelden
window.habmail.getAccount() // { email, uid }

// Sofort verschicken, ohne Klick:
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
```

`sendMail` und `replyTo` laufen über denselben authentifizierten Weg wie der
Senden-Knopf — es geht also nur, was der angemeldete Nutzer ohnehin darf.
Ohne `mailboxId` verschickt `sendMail` aus dem ersten Postfach, `replyTo` aus
dem, in dem die Mail ankam. `document.documentElement.dataset.habmailAgentApi`
enthält die Version, sobald die API bereitsteht.

---

## 3. Oberfläche anklicken

Wer doch klicken will, findet stabile Anker:

| Element | Anker |
|---|---|
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

---

## Regeln

- **Keys gehören in Environment-Variablen**, nie in Quelltext, Beispiele oder
  Commit-Nachrichten.
- **Pro Agent ein eigener Key** — dann lässt sich einer sperren, ohne die
  anderen abzuschalten.
- **Vor dem ersten echten Versand `dryRun`.**
- **`allowedTo` setzen**, wenn feststeht, wohin gesendet wird. Ein Key, der
  nur an eine Adresse senden darf, ist im Ernstfall harmlos.
