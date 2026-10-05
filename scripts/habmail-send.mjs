#!/usr/bin/env node
/**
 * Mail mit Anhängen von der Platte verschicken — über /api/send-mail.
 *
 * Das MCP-Werkzeug `send_mail` nimmt Anhänge nur als Base64 im Aufruf. Ein
 * Agent im Chat kann eine PDF aber nicht Zeichen für Zeichen abtippen; dieses
 * Skript liest die Dateien selbst und reicht sie durch. Für Mails ohne Anhang
 * reicht das Werkzeug.
 *
 *   node scripts/habmail-send.mjs --to kunde@firma.de --subject "Angebot" \
 *     --body-file text.txt --attach angebot.pdf --attach foto.jpg [--send]
 *
 * Ohne --send ist es ein Probelauf: die fertige Mail kommt zurück, verschickt
 * wird nichts. Der Key kommt aus HABMAIL_AGENT_KEY, sonst aus dem
 * MCP-Eintrag „habmail" in ~/.claude.json — er steht nie auf der Kommandozeile.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

const TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

// Dieselbe Grenze wie in api/send-mail.ts — hier schon melden, statt die
// Dateien erst hochzuladen.
const MAX_TOTAL_BYTES = 3 * 1024 * 1024

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { attach: [], send: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--send') {
      out.send = true
      continue
    }
    const value = argv[i + 1]
    if (!flag.startsWith('--') || value === undefined) fail(`Unklare Angabe: ${flag}`)
    i += 1
    if (flag === '--attach') out.attach.push(value)
    else out[flag.slice(2)] = value
  }
  return out
}

/** Der Key aus der Umgebung, sonst aus dem MCP-Eintrag von Claude Code. */
function findKey() {
  const fromEnv = process.env.HABMAIL_AGENT_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
    const servers = [config.mcpServers, ...Object.values(config.projects ?? {}).map((p) => p.mcpServers)]
    for (const list of servers) {
      const header = list?.habmail?.headers?.Authorization
      if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
    }
  } catch {
    /* keine Claude-Konfiguration — dann bleibt nur die Umgebung */
  }
  return ''
}

const args = parseArgs(process.argv.slice(2))
const body = args['body-file'] ? readFileSync(args['body-file'], 'utf8') : (args.body ?? '')
if (!args.to || !args.subject || body.trim() === '') {
  fail('Gebraucht werden --to, --subject und --body oder --body-file.')
}

const key = findKey()
if (key === '') fail('Kein Agent-Key: HABMAIL_AGENT_KEY setzen oder den MCP-Server „habmail" eintragen.')

let total = 0
const attachments = args.attach.map((path) => {
  const data = readFileSync(path)
  total += data.length
  return {
    filename: basename(path),
    contentType: TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    contentBase64: data.toString('base64'),
  }
})
if (total > MAX_TOTAL_BYTES) {
  fail(`Die Anhänge sind zusammen ${(total / 1024 / 1024).toFixed(1)} MB, erlaubt sind 3 MB.`)
}

const base = (args.url ?? process.env.HABMAIL_URL ?? 'https://hab-mail.vercel.app').replace(/\/$/, '')
const response = await fetch(`${base}/api/send-mail`, {
  method: 'POST',
  headers: { 'X-HabMail-Agent-Key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    kind: 'new',
    to: args.to,
    subject: args.subject,
    body,
    ...(args.mailbox ? { mailboxId: args.mailbox } : {}),
    attachments,
    dryRun: !args.send,
  }),
})
const raw = await response.text()
console.log(raw)
if (!response.ok) process.exit(1)
if (!args.send) console.error('Probelauf, es ging nichts raus. Mit --send verschicken.')
