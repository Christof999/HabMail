#!/usr/bin/env node
/**
 * Bestand umziehen: den Inhalt der Anhänge aus den Mails herauslösen.
 *
 * Neue Mails legt `functions/store.js` schon getrennt ab. Was vorher kam,
 * trägt das Base64 jeder Datei noch im Datensatz der Mail — und genau das lädt
 * die Oberfläche bei jedem Öffnen mit. Dieses Skript holt es nach:
 *
 *   1. sichern    Jeden Zweig vollständig in eine Datei schreiben.
 *   2. kopieren   Den Inhalt nach `attachmentData/<zweig>/<mail>/<nr>` legen.
 *   3. prüfen     Zurücklesen und Zeichen für Zeichen vergleichen.
 *   4. entfernen  Erst dann `dataBase64` aus der Mail nehmen und `dataKey`
 *                 setzen — und nur, wenn die Prüfung ohne Abweichung war.
 *
 * Ohne Schalter passiert nichts außer 1: es wird gesichert und gezählt.
 *
 *   node scripts/migrate-attachments.mjs --project <id> --backup <ordner>
 *   node scripts/migrate-attachments.mjs --project <id> --backup <ordner> --copy
 *   node scripts/migrate-attachments.mjs --project <id> --backup <ordner> --copy --strip
 *
 * Läuft über die Firebase-CLI und deren Anmeldung; ein Dienstkonto braucht es
 * dafür nicht. Mehrfach starten ist harmlos: was schon umgezogen ist, hat kein
 * `dataBase64` mehr und wird übersprungen.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BRANCHES = ['emails', 'sentEmails']
/** Ein Schreibzugriff bleibt deutlich unter dem, was die Datenbank annimmt. */
const CHUNK_BYTES = 8 * 1024 * 1024

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const project = option('project')
const backupDir = option('backup')
const instance = option('instance') ?? `${project}-default-rtdb`
const doCopy = process.argv.includes('--copy')
const doStrip = process.argv.includes('--strip')

if (!project || !backupDir) {
  console.error('Gebraucht werden --project <id> und --backup <ordner>.')
  process.exit(1)
}
if (doStrip && !doCopy) {
  console.error('--strip geht nur zusammen mit --copy: entfernt wird erst nach Kopie und Prüfung.')
  process.exit(1)
}
mkdirSync(backupDir, { recursive: true })

function firebase(args) {
  return execFileSync(
    'firebase',
    [...args, '--project', project, '--instance', instance],
    { shell: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Einen Pfad in eine Datei holen und als JSON lesen. */
function download(path, file, { shallow = false } = {}) {
  firebase(['database:get', path, '-o', `"${file}"`, ...(shallow ? ['--shallow'] : [])])
  const raw = readFileSync(file, 'utf8')
  return raw.trim() === '' ? null : JSON.parse(raw)
}

let chunkNumber = 0
function upload(path, value) {
  chunkNumber += 1
  const file = join(backupDir, `_schreiben-${chunkNumber}.json`)
  writeFileSync(file, JSON.stringify(value))
  firebase(['database:update', path, `"${file}"`, '--force'])
}

/** Arrays kommen je nach Lücken als Array oder als Objekt mit Ziffern zurück. */
function entriesOf(list) {
  if (Array.isArray(list)) return list.map((value, index) => [String(index), value])
  if (list !== null && typeof list === 'object') return Object.entries(list)
  return []
}

/** Alle Anhänge eines Zweigs, deren Inhalt noch in der Mail steht. */
function inlineAttachments(tree) {
  const found = []
  for (const [mailKey, mail] of Object.entries(tree ?? {})) {
    for (const [index, attachment] of entriesOf(mail?.attachments)) {
      const data = attachment?.dataBase64
      if (typeof data === 'string' && data !== '') found.push({ mailKey, index, data })
    }
  }
  return found
}

/** In Stapel teilen, die je unter der Schreibgrenze bleiben. */
function chunked(items, sizeOf) {
  const chunks = [[]]
  let bytes = 0
  for (const item of items) {
    const size = sizeOf(item)
    if (bytes + size > CHUNK_BYTES && chunks[chunks.length - 1].length > 0) {
      chunks.push([])
      bytes = 0
    }
    chunks[chunks.length - 1].push(item)
    bytes += size
  }
  return chunks.filter((chunk) => chunk.length > 0)
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const safeName = (text) => text.replace(/[^A-Za-z0-9_-]+/g, '_')

async function migrateBranch(root, branch) {
  const label = `${root}/${branch}`
  const file = join(backupDir, `${safeName(root)}-${branch}.json`)
  const tree = download(`/${root}/${branch}`, file)
  const mails = Object.keys(tree ?? {}).length
  const found = inlineAttachments(tree)
  const bytes = found.reduce((sum, item) => sum + item.data.length, 0)
  console.log(`${label}: ${mails} Mails gesichert, ${found.length} Anhänge mit ${megabytes(bytes)} in den Mails.`)
  if (found.length === 0 || !doCopy) return { found: found.length, bytes, stripped: 0 }

  // --- kopieren ---
  const dataPath = `/${root}/attachmentData/${branch}`
  const byMail = new Map()
  for (const item of found) {
    if (!byMail.has(item.mailKey)) byMail.set(item.mailKey, [])
    byMail.get(item.mailKey).push(item)
  }
  // Je Mail ein Eintrag mit allen ihren Dateien — und zwar mit "mail/nr" als
  // Schlüssel, damit nichts überschrieben wird, was dort schon liegt.
  const copies = chunked([...byMail.values()], (items) =>
    items.reduce((sum, item) => sum + item.data.length, 0),
  )
  for (const [n, chunk] of copies.entries()) {
    const update = {}
    for (const items of chunk) for (const item of items) update[`${item.mailKey}/${item.index}`] = item.data
    upload(dataPath, update)
    console.log(`${label}: kopiert ${n + 1}/${copies.length}`)
  }

  // --- prüfen ---
  const stored = download(dataPath, join(backupDir, `${safeName(root)}-${branch}-geprueft.json`)) ?? {}
  const wrong = found.filter((item) => {
    const node = stored[item.mailKey]
    return (node === null || node === undefined ? undefined : node[item.index]) !== item.data
  })
  if (wrong.length > 0) {
    console.error(`${label}: ${wrong.length} Anhänge stimmen nach dem Kopieren NICHT überein — nichts entfernt.`)
    return { found: found.length, bytes, stripped: 0, wrong: wrong.length }
  }
  console.log(`${label}: alle ${found.length} Anhänge geprüft, Kopie stimmt.`)
  if (!doStrip) return { found: found.length, bytes, stripped: 0 }

  // --- entfernen ---
  // Mails, die in der Zwischenzeit gelöscht wurden, bleiben gelöscht: ein
  // Schreibzugriff auf ihre Anhänge würde sie halb wieder anlegen.
  const existing = download(`/${root}/${branch}`, join(backupDir, '_vorhanden.json'), { shallow: true }) ?? {}
  const strips = chunked(
    found.filter((item) => existing[item.mailKey] !== undefined),
    () => 200,
  )
  let stripped = 0
  for (const chunk of strips) {
    const update = {}
    for (const item of chunk) {
      update[`${item.mailKey}/attachments/${item.index}/dataBase64`] = null
      update[`${item.mailKey}/attachments/${item.index}/dataKey`] = item.index
    }
    upload(`/${root}/${branch}`, update)
    stripped += chunk.length
  }
  console.log(`${label}: ${stripped} Anhänge aus den Mails genommen.`)
  return { found: found.length, bytes, stripped }
}

const roots = []
for (const top of ['users', 'tenants']) {
  const keys = download(`/${top}`, join(backupDir, `_${top}.json`), { shallow: true })
  for (const key of Object.keys(keys ?? {})) roots.push(`${top}/${key}`)
}

const total = { found: 0, bytes: 0, stripped: 0, wrong: 0 }
for (const root of roots) {
  for (const branch of BRANCHES) {
    const result = await migrateBranch(root, branch)
    total.found += result.found
    total.bytes += result.bytes
    total.stripped += result.stripped
    total.wrong += result.wrong ?? 0
  }
}

console.log(
  `\nGesamt: ${total.found} Anhänge mit ${megabytes(total.bytes)} in den Mails, ` +
    `${total.stripped} herausgenommen, ${total.wrong} Abweichungen.`,
)
if (!doCopy) console.log('Nur gesichert und gezählt. Mit --copy kopieren, mit --copy --strip umziehen.')
if (total.wrong > 0) process.exit(1)
