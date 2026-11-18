import { tFormat, t } from './i18n'
import { translateText } from './languageSession'

import { useEffect, useMemo, useRef, useState } from 'react'
import { get, ref } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import { splitMailText } from './mailText'
import type { EmailRow } from './types'

type Props = {
  row: EmailRow
  /** Wo die HTML-Fassungen liegen; leer = nur Klartext. */
  htmlRoot: string
}

/**
 * Der Inhalt einer Mail: die HTML-Fassung, wenn es eine gibt, sonst der
 * Klartext. In beiden Fällen ist der zitierte Verlauf erst eingeklappt.
 */
export function MailBody({ row, htmlRoot }: Props) {
  const [html, setHtml] = useState<string | null>(null)
  const [htmlFailed, setHtmlFailed] = useState(false)
  const wantsHtml = row.hasHtml === true && htmlRoot !== ''

  useEffect(() => {
    if (!wantsHtml) return
    let active = true
    get(ref(getFirebaseDb(), `${htmlRoot}/${row.id}`))
      .then((snap) => {
        if (!active) return
        const value: unknown = snap.val()
        if (typeof value === 'string' && value.trim() !== '') setHtml(value)
        else setHtmlFailed(true)
      })
      .catch(() => {
        if (active) setHtmlFailed(true)
      })
    return () => {
      active = false
    }
  }, [wantsHtml, htmlRoot, row.id])

  if (wantsHtml && !htmlFailed) {
    return html === null ? (
      <p className="muted small">{t('Lädt …')}</p>
    ) : (
      <HtmlMail html={html} title={row.subject} />
    )
  }
  return <PlainMail text={row.originalBody} />
}

function PlainMail({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false)
  const { main, quoted } = useMemo(() => splitMailText(text || ''), [text])
  const quotedLines = quoted === '' ? 0 : quoted.split('\n').length

  return (
    <div className="mail-text">
      <div className="mail-text-main">{translateText(main || '—')}</div>
      {quoted === '' ? null : (
        <>
          <button
            type="button"
            className="mail-quote-toggle"
            aria-expanded={showQuoted}
            onClick={() => setShowQuoted((v) => !v)}
          >
            <span className="mail-quote-dots" aria-hidden>
              ···
            </span>
            {showQuoted
              ? t('Verlauf ausblenden')
              : tFormat('Verlauf anzeigen ({0} Zeilen)', quotedLines)}
          </button>
          {showQuoted ? <div className="mail-text-quoted">{translateText(quoted)}</div> : null}
        </>
      )}
    </div>
  )
}

/*
 * Fremdes HTML läuft in einem Rahmen ohne Skripte und ohne Formulare.
 * allow-same-origin ist nur da, damit die Höhe messbar ist — ohne allow-scripts
 * kann der Inhalt damit nichts anfangen. Bilder von fremden Servern sind
 * Zählpixel, bis jemand sie ausdrücklich lädt.
 */
const QUOTE_SELECTORS = [
  '.gmail_quote',
  'blockquote[type="cite"]',
  '.moz-cite-prefix',
  '#divRplyFwdMsg',
  '#divRplyFwdMsg ~ *',
  '#appendonsend ~ *',
  '.yahoo_quoted',
]

function HtmlMail({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const [remoteImages, setRemoteImages] = useState(false)
  const [showQuoted, setShowQuoted] = useState(false)
  const [hasQuote, setHasQuote] = useState(false)
  const [blockedImages, setBlockedImages] = useState(false)

  const doc = useMemo(() => {
    const imgSrc = remoteImages ? 'data: cid: https: http:' : 'data: cid:'
    const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:`
    const hideQuotes = showQuoted ? '' : `${QUOTE_SELECTORS.join(',')}{display:none!important}`
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
html,body{margin:0;padding:0;background:#fff;color:#111}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow-wrap:anywhere;padding:4px 2px}
img{max-width:100%;height:auto}
table{max-width:100%!important}
a{color:#5a2fd4}
${hideQuotes}
</style></head><body>${html}</body></html>`
  }, [html, remoteImages, showQuoted])

  useEffect(() => {
    const el = frame.current
    if (el === null) return
    let observer: ResizeObserver | undefined
    const onLoad = () => {
      const body = el.contentDocument?.body
      if (!body) return
      const measure = () => setHeight(Math.max(60, body.scrollHeight + 8))
      measure()
      observer?.disconnect()
      observer = new ResizeObserver(measure)
      observer.observe(body)
      setHasQuote(QUOTE_SELECTORS.some((s) => body.querySelector(s) !== null))
      setBlockedImages(
        Array.from(body.querySelectorAll('img')).some((img) => /^https?:/i.test(img.getAttribute('src') ?? '')),
      )
    }
    el.addEventListener('load', onLoad)
    return () => {
      el.removeEventListener('load', onLoad)
      observer?.disconnect()
    }
  }, [])

  return (
    <div className="mail-html">
      {blockedImages && !remoteImages ? (
        <p className="mail-html-notice muted small">
          {t('Bilder von fremden Servern sind blockiert — sie verraten dem Absender, dass die Mail geöffnet wurde.')}{' '}
          <button type="button" className="link-btn" onClick={() => setRemoteImages(true)}>
            {t('Bilder anzeigen')}
          </button>
        </p>
      ) : null}
      <iframe
        ref={frame}
        className="mail-html-frame"
        title={tFormat('Inhalt der Mail „{0}"', title || t('(Ohne Betreff)'))}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
      />
      {hasQuote ? (
        <button
          type="button"
          className="mail-quote-toggle"
          aria-expanded={showQuoted}
          onClick={() => setShowQuoted((v) => !v)}
        >
          <span className="mail-quote-dots" aria-hidden>
            ···
          </span>
          {showQuoted ? t('Verlauf ausblenden') : t('Verlauf anzeigen')}
        </button>
      ) : null}
    </div>
  )
}
