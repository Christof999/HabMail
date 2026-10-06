import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDays,
  ALL_DAY_REMINDER_CHOICES,
  MAX_REMINDERS,
  MAX_REMINDER_MINUTES,
  deleteEvent,
  eventsOnDay,
  feedToken,
  feedUrl,
  formatDayLong,
  formatTime,
  formatWhen,
  fromInputs,
  monthWeeks,
  normalizeReminders,
  overlapping,
  REMINDER_CHOICES,
  reminderLabel,
  remindersOf,
  sameDay,
  saveEvent,
  startOfDay,
  toDateInput,
  toTimeInput,
  watchEvents,
  type CalendarEvent,
  type CalendarEventInput,
} from './calendar'

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const MONTH = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' })
/** So viele Termine passen in ein Tagesfeld, bevor „+2" dasteht. */
const CHIPS_PER_DAY = 3
/** Die Liste unter dem Monat reicht so weit voraus. */
const UPCOMING_DAYS = 60

export type CalendarDraft = Partial<CalendarEventInput>

type Editing = { id: string | null; draft: CalendarDraft }

/** Was im Formular steht — Felder als Text, wie die Eingaben sie liefern. */
type FormState = {
  title: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  location: string
  notes: string
  reminders: number[]
}

function formFrom(draft: CalendarDraft, fallbackDay: Date): FormState {
  // Ein neuer Termin beginnt zur nächsten vollen Stunde — am gewählten Tag,
  // oder wenn das heute ist, nicht in der Vergangenheit.
  const base = new Date(fallbackDay)
  const now = new Date()
  base.setHours(sameDay(base, now) ? Math.min(now.getHours() + 1, 23) : 9, 0, 0, 0)

  const allDay = draft.allDay === true
  const start = new Date(draft.start ?? base.getTime())
  // Ganztägig endet in der Datenbank um Mitternacht danach; im Formular steht
  // der letzte Tag, wie man ihn sagen würde.
  const end = new Date(
    draft.end === undefined ? start.getTime() + 3_600_000 : allDay ? draft.end - 1 : draft.end,
  )
  return {
    title: draft.title ?? '',
    allDay,
    startDate: toDateInput(start),
    startTime: toTimeInput(start),
    endDate: toDateInput(end),
    endTime: toTimeInput(end),
    location: draft.location ?? '',
    notes: draft.notes ?? '',
    reminders: remindersOf(draft),
  }
}

/** Aus dem Formular der Termin — oder der Grund, warum es noch keiner ist. */
function eventFrom(
  form: FormState,
  kept?: { emailId?: string; icalUid?: string },
): CalendarEventInput | string {
  if (form.title.trim() === '') return 'Der Termin braucht einen Titel.'
  if (form.startDate === '' || form.endDate === '') return 'Datum fehlt.'

  const start = form.allDay ? fromInputs(form.startDate, '00:00') : fromInputs(form.startDate, form.startTime)
  const end = form.allDay
    ? addDays(new Date(fromInputs(form.endDate, '00:00')), 1).getTime()
    : fromInputs(form.endDate, form.endTime)
  if (Number.isNaN(start) || Number.isNaN(end)) return 'Datum oder Uhrzeit ist unvollständig.'
  if (end <= start) return 'Das Ende liegt nicht nach dem Anfang.'

  return {
    title: form.title,
    start,
    end,
    allDay: form.allDay,
    ...(form.location.trim() ? { location: form.location } : {}),
    ...(form.notes.trim() ? { notes: form.notes } : {}),
    ...(form.reminders.length > 0 ? { reminders: form.reminders } : {}),
    ...(kept?.emailId ? { emailId: kept.emailId } : {}),
    ...(kept?.icalUid ? { icalUid: kept.icalUid } : {}),
  }
}

/**
 * Wie viel die Tastatur vom unteren Rand verdeckt.
 *
 * Auf dem iPhone bleibt das Fenster am unteren Rand des Bildschirms hängen,
 * die Tastatur liegt darüber, und der Titel rutscht aus dem Sichtbaren. Der
 * Wert hebt das Blatt um genau diese Höhe.
 */
function useKeyboardLift(enabled: boolean): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setInset(0)
      return
    }
    const viewport = window.visualViewport
    if (viewport === null || viewport === undefined) return

    const sync = () => {
      const covered = Math.round(window.innerHeight - viewport.height - viewport.offsetTop)
      setInset(covered > 60 ? covered : 0)
      // iOS schiebt die Seite, damit das Feld frei liegt. Das Blatt rechnet
      // die Tastatur selbst ein — die Seite soll stehen bleiben.
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }

    viewport.addEventListener('resize', sync)
    viewport.addEventListener('scroll', sync)
    sync()
    return () => {
      viewport.removeEventListener('resize', sync)
      viewport.removeEventListener('scroll', sync)
    }
  }, [enabled])

  return inset
}

function EventDialog({
  uid,
  editing,
  events,
  fallbackDay,
  onClose,
}: {
  uid: string
  editing: Editing
  events: CalendarEvent[]
  fallbackDay: Date
  onClose: () => void
}) {
  const [form, setForm] = useState(() => formFrom(editing.draft, fallbackDay))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = eventFrom(form, {
    emailId: editing.draft.emailId,
    icalUid: editing.draft.icalUid,
  })
  // Schon beim Tippen zeigen, was im Weg steht — nicht erst nach dem Speichern.
  const conflicts =
    typeof parsed === 'string' || parsed.allDay
      ? []
      : overlapping(events, parsed.start, parsed.end, editing.id)

  function patch(change: Partial<FormState>) {
    setForm((current) => {
      const next = { ...current, ...change }
      // Wer den Anfang verschiebt, meint meist den ganzen Termin: das Ende
      // wandert mit, statt plötzlich vor dem Anfang zu liegen.
      if (change.startDate !== undefined && next.endDate < next.startDate) next.endDate = next.startDate
      if (change.startTime !== undefined && !next.allDay && next.endDate === next.startDate) {
        const before = fromInputs(current.endDate, current.endTime) - fromInputs(current.startDate, current.startTime)
        const end = new Date(fromInputs(next.startDate, next.startTime) + Math.max(before, 900_000))
        next.endDate = toDateInput(end)
        next.endTime = toTimeInput(end)
      }
      // Die Auswahl für Erinnerungen ist je nach Art eine andere.
      if (change.allDay !== undefined && change.allDay !== current.allDay) next.reminders = []
      return next
    })
  }

  async function submit() {
    if (typeof parsed === 'string') {
      setError(parsed)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await saveEvent(uid, editing.id, parsed, { reminders: remindersOf(editing.draft) })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Der Termin ließ sich nicht speichern.')
      setBusy(false)
    }
  }

  async function remove() {
    if (editing.id === null) return
    setBusy(true)
    try {
      await deleteEvent(uid, editing.id, remindersOf(editing.draft))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Der Termin ließ sich nicht löschen.')
      setBusy(false)
    }
  }

  const reminderChoices = form.allDay ? ALL_DAY_REMINDER_CHOICES : REMINDER_CHOICES
  const [customAmount, setCustomAmount] = useState('15')
  const [customUnit, setCustomUnit] = useState<'minutes' | 'hours' | 'days'>('minutes')
  const [reminderNote, setReminderNote] = useState<string | null>(null)
  const presetMinutes = new Set(reminderChoices.map((choice) => choice.minutes))
  const customReminders = form.reminders.filter((minutes) => !presetMinutes.has(minutes))

  function setReminders(reminders: number[]) {
    setReminderNote(null)
    patch({ reminders: normalizeReminders(reminders) })
  }

  function toggleReminder(minutes: number) {
    if (form.reminders.includes(minutes)) {
      setReminders(form.reminders.filter((value) => value !== minutes))
      return
    }
    if (form.reminders.length >= MAX_REMINDERS) {
      setReminderNote('Höchstens acht Erinnerungen.')
      return
    }
    setReminders([...form.reminders, minutes])
  }

  function addCustomReminder() {
    const amount = Number(customAmount)
    if (!Number.isInteger(amount) || amount < 0) {
      setReminderNote('Bitte eine ganze Zahl ab null.')
      return
    }
    if (customUnit !== 'minutes' && amount === 0) {
      setReminderNote('Bitte eine Zeit größer als null.')
      return
    }
    const minutes = customUnit === 'days' ? amount * 1440 : customUnit === 'hours' ? amount * 60 : amount
    if (minutes > MAX_REMINDER_MINUTES) {
      setReminderNote('Höchstens vier Wochen vorher.')
      return
    }
    if (form.reminders.includes(minutes)) {
      setReminderNote(null)
      return
    }
    toggleReminder(minutes)
  }
  const titleRef = useRef<HTMLInputElement>(null)
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  )
  const keyboardInset = useKeyboardLift(narrow)

  // Auf dem Handy öffnet ein sofortiger Fokus die Tastatur und schiebt das
  // Blatt, bevor man den Titel sieht. Dort tippt man ihn selbst an.
  useEffect(() => {
    if (narrow) return
    titleRef.current?.focus()
  }, [narrow])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const onChange = () => setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-event-title"
      data-testid="calendar-event-dialog"
      onClick={() => !busy && onClose()}
    >
      <form
        className="modal card calendar-dialog calendar-event-sheet"
        style={{ '--keyboard-inset': `${keyboardInset}px` } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="calendar-dialog-head">
          <h3 id="calendar-event-title">{editing.id === null ? 'Neuer Termin' : 'Termin bearbeiten'}</h3>

          <label className="folder-modal-label calendar-title-field">
            Titel
            <input
              ref={titleRef}
              id="calendar-event-title-input"
              data-testid="calendar-event-title"
              type="text"
              value={form.title}
              maxLength={200}
              enterKeyHint="next"
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>
        </div>

        <div className="calendar-dialog-body">
        <label className="calendar-check">
          <input
            type="checkbox"
            data-testid="calendar-event-allday"
            checked={form.allDay}
            onChange={(e) => patch({ allDay: e.target.checked })}
          />
          Ganztägig
        </label>

        <div className="calendar-when">
          <label className="folder-modal-label">
            Beginn
            <span className="calendar-when-row">
              <input
                type="date"
                data-testid="calendar-event-start-date"
                value={form.startDate}
                onChange={(e) => patch({ startDate: e.target.value })}
              />
              {form.allDay ? null : (
                <input
                  type="time"
                  data-testid="calendar-event-start-time"
                  value={form.startTime}
                  onChange={(e) => patch({ startTime: e.target.value })}
                />
              )}
            </span>
          </label>
          <label className="folder-modal-label">
            Ende
            <span className="calendar-when-row">
              <input
                type="date"
                data-testid="calendar-event-end-date"
                value={form.endDate}
                min={form.startDate}
                onChange={(e) => patch({ endDate: e.target.value })}
              />
              {form.allDay ? null : (
                <input
                  type="time"
                  data-testid="calendar-event-end-time"
                  value={form.endTime}
                  onChange={(e) => patch({ endTime: e.target.value })}
                />
              )}
            </span>
          </label>
        </div>

        {conflicts.length > 0 ? (
          <p className="calendar-conflict small" role="status" data-testid="calendar-event-conflict">
            <strong>Überschneidet sich mit:</strong>{' '}
            {conflicts
              .slice(0, 3)
              .map((c) => `${c.title} (${formatWhen(c)})`)
              .join(', ')}
            {conflicts.length > 3 ? ` und ${conflicts.length - 3} weiteren` : ''}
          </p>
        ) : null}

        <label className="folder-modal-label">
          Ort
          <input
            type="text"
            data-testid="calendar-event-location"
            value={form.location}
            maxLength={300}
            onChange={(e) => patch({ location: e.target.value })}
          />
        </label>

        <fieldset className="calendar-reminders" data-testid="calendar-event-reminder">
          <legend>Erinnerungen aufs Telefon</legend>
          <div className="calendar-reminder-picks">
            {reminderChoices.map((choice) => {
              const on = form.reminders.includes(choice.minutes)
              return (
                <button
                  key={choice.minutes}
                  type="button"
                  className={on ? 'calendar-reminder-pick is-on' : 'calendar-reminder-pick'}
                  aria-pressed={on}
                  onClick={() => toggleReminder(choice.minutes)}
                >
                  {choice.label}
                </button>
              )
            })}
          </div>
          {customReminders.map((minutes) => (
            <div key={minutes} className="calendar-reminder-row">
              <span>{reminderLabel(minutes)}</span>
              <button
                type="button"
                className="ghost small-btn"
                aria-label={`${reminderLabel(minutes)} entfernen`}
                onClick={() => toggleReminder(minutes)}
              >
                Entfernen
              </button>
            </div>
          ))}
          <div
            className="calendar-reminder-custom"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addCustomReminder()
            }}
          >
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_REMINDER_MINUTES}
              step={1}
              value={customAmount}
              aria-label="Eigene Erinnerung"
              data-testid="calendar-reminder-amount"
              onChange={(e) => setCustomAmount(e.target.value)}
            />
            <select
              value={customUnit}
              aria-label="Einheit"
              data-testid="calendar-reminder-unit"
              onChange={(e) => setCustomUnit(e.target.value as 'minutes' | 'hours' | 'days')}
            >
              <option value="minutes">Minuten vorher</option>
              <option value="hours">Stunden vorher</option>
              <option value="days">Tage vorher</option>
            </select>
            <button type="button" className="ghost small-btn" data-testid="calendar-reminder-add" onClick={addCustomReminder}>
              Hinzufügen
            </button>
          </div>
          {reminderNote ? (
            <p className="muted small" role="status">
              {reminderNote}
            </p>
          ) : null}
        </fieldset>

        <label className="folder-modal-label">
          Notiz
          <textarea
            data-testid="calendar-event-notes"
            value={form.notes}
            rows={3}
            maxLength={4000}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </label>
        </div>

        {error ? (
          <p className="error small" role="alert" data-testid="calendar-event-error">
            {error}
          </p>
        ) : null}

        <div className="modal-actions calendar-dialog-actions">
          {editing.id !== null ? (
            <button
              type="button"
              className="ghost calendar-delete"
              data-testid="calendar-event-delete"
              disabled={busy}
              onClick={() => void remove()}
            >
              Löschen
            </button>
          ) : null}
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" data-testid="calendar-event-save" disabled={busy}>
            {busy ? 'Speichert…' : 'Speichern'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Der Abo-Link: damit erscheinen die Termine im Kalender des Telefons. */
function SubscribeDialog({ uid, onClose }: { uid: string; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    feedToken(uid)
      .then((value) => {
        if (active) setToken(value)
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Der Link ließ sich nicht erzeugen.')
      })
    return () => {
      active = false
    }
  }, [uid])

  async function renew() {
    setBusy(true)
    setCopied(false)
    try {
      setToken(await feedToken(uid, { renew: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Der Link ließ sich nicht erneuern.')
    } finally {
      setBusy(false)
    }
  }

  const link = token === null ? '' : feedUrl(uid, token)

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-subscribe-title"
      onClick={onClose}
    >
      <div className="modal card calendar-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 id="calendar-subscribe-title">Kalender abonnieren</h3>
        <p className="muted small">
          Mit diesem Link erscheinen deine Termine im Kalender des Telefons oder Rechners — auch im
          Widget. Dort sind sie nur zu sehen; geändert wird hier in HabMail.
        </p>

        {error ? (
          <p className="error small" role="alert">
            {error}
          </p>
        ) : token === null ? (
          <p className="muted small">Link wird erzeugt…</p>
        ) : (
          <>
            <a className="calendar-subscribe-go" href={feedUrl(uid, token, 'webcal')}>
              Auf diesem Gerät abonnieren
            </a>
            <label className="folder-modal-label">
              Oder den Link kopieren (Google Kalender: „Weitere Kalender → Per URL")
              <input
                type="text"
                readOnly
                data-testid="calendar-feed-url"
                value={link}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <div className="modal-actions calendar-subscribe-actions">
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  void navigator.clipboard.writeText(link).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? 'Kopiert' : 'Link kopieren'}
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void renew()}>
                Neuen Link erzeugen
              </button>
            </div>
            <p className="muted small">
              Wer den Link kennt, kann deine Termine lesen. „Neuen Link erzeugen" macht den alten
              sofort ungültig. Apple sieht etwa alle 15 Minuten nach, Google oft erst nach Stunden.
            </p>
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Fertig
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Der Kalender: oben der Monat, darunter der gewählte Tag und was als
 * Nächstes ansteht.
 *
 * `draft` kommt von außen, wenn etwas anderes einen Termin vorschlägt — ein
 * Agent oder später eine Einladung aus einer Mail. Dann geht das Formular
 * damit auf.
 */
export default function CalendarView({
  uid,
  draft,
  eventId = null,
  onDraftHandled,
}: {
  uid: string
  draft?: CalendarDraft | null
  /** Gesetzt, wenn der Vorschlag einen bestehenden Termin ändert statt einen neuen anzulegen. */
  eventId?: string | null
  onDraftHandled?: () => void
}) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [today, setToday] = useState(() => startOfDay(new Date()))
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState(today)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [subscribing, setSubscribing] = useState(false)

  useEffect(
    () =>
      watchEvents(
        uid,
        (list) => {
          setEvents(list)
          setLoaded(true)
          setError(null)
        },
        (message) => {
          setError(message)
          setLoaded(true)
        },
      ),
    [uid],
  )

  // Bleibt die App über Mitternacht offen, soll „heute" nicht gestern sein.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = startOfDay(new Date())
      setToday((current) => (sameDay(current, now) ? current : now))
    }, 60_000)
    return () => clearInterval(timer)
  }, [])

  // Ein Vorschlag von außen öffnet das Formular. Beim Zeichnen übernommen und
  // nicht in einem Effekt: der würde erst ein Bild ohne Formular zeigen.
  const [takenDraft, setTakenDraft] = useState<CalendarDraft | null>(null)
  if (draft && draft !== takenDraft) {
    setTakenDraft(draft)
    setEditing({ id: eventId, draft })
    if (typeof draft.start === 'number') {
      const day = startOfDay(new Date(draft.start))
      setSelected(day)
      setMonth(new Date(day.getFullYear(), day.getMonth(), 1))
    }
  }
  useEffect(() => {
    if (draft) onDraftHandled?.()
  }, [draft, onDraftHandled])

  const weeks = useMemo(() => monthWeeks(month.getFullYear(), month.getMonth()), [month])
  const selectedEvents = useMemo(() => eventsOnDay(events, selected), [events, selected])

  // Was nach dem gewählten Tag kommt, nach Tagen gruppiert.
  const upcoming = useMemo(() => {
    const from = addDays(selected, 1)
    const days: { day: Date; events: CalendarEvent[] }[] = []
    for (let i = 0; i < UPCOMING_DAYS && days.length < 12; i += 1) {
      const day = addDays(from, i)
      const list = eventsOnDay(events, day)
      if (list.length > 0) days.push({ day, events: list })
    }
    return days
  }, [events, selected])

  function show(day: Date) {
    setSelected(startOfDay(day))
    setMonth(new Date(day.getFullYear(), day.getMonth(), 1))
  }

  function edit(event: CalendarEvent) {
    const { id, ...rest } = event
    setEditing({ id, draft: rest })
  }

  function eventRow(event: CalendarEvent, day: Date) {
    return (
      <li key={`${event.id}-${day.getTime()}`}>
        <button
          type="button"
          className="calendar-event"
          data-testid="calendar-event"
          data-event-id={event.id}
          onClick={() => edit(event)}
        >
          <span className="calendar-event-when">{formatWhen(event, day)}</span>
          <span className="calendar-event-body">
            <strong>{event.title}</strong>
            {event.location ? <span className="muted small">{event.location}</span> : null}
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="calendar" data-testid="calendar-view">
      <div className="calendar-head card">
        <div className="calendar-nav">
          <button
            type="button"
            className="ghost small-btn"
            aria-label="Voriger Monat"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            ‹
          </button>
          <h2 className="calendar-month" aria-live="polite">
            {MONTH.format(month)}
          </h2>
          <button
            type="button"
            className="ghost small-btn"
            aria-label="Nächster Monat"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            ›
          </button>
        </div>
        <div className="calendar-actions">
          <button type="button" className="ghost small-btn" onClick={() => show(today)}>
            Heute
          </button>
          <button type="button" className="ghost small-btn" onClick={() => setSubscribing(true)}>
            Abonnieren
          </button>
          <button
            type="button"
            className="small-btn"
            data-testid="calendar-new"
            onClick={() => setEditing({ id: null, draft: {} })}
          >
            + Termin
          </button>
        </div>
      </div>

      {error ? (
        <p className="error" role="alert">
          Kalender: {error}
        </p>
      ) : null}

      <div className="calendar-grid card" role="grid" aria-label={MONTH.format(month)}>
        <div className="calendar-weekdays" role="row">
          {WEEKDAYS.map((name) => (
            <span key={name} role="columnheader">
              {name}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div className="calendar-week" role="row" key={week[0].getTime()}>
            {week.map((day) => {
              const list = eventsOnDay(events, day)
              const classes = [
                'calendar-day',
                day.getMonth() === month.getMonth() ? '' : 'calendar-day--other',
                sameDay(day, today) ? 'calendar-day--today' : '',
                sameDay(day, selected) ? 'calendar-day--selected' : '',
              ]
              return (
                <button
                  type="button"
                  role="gridcell"
                  key={day.getTime()}
                  className={classes.filter(Boolean).join(' ')}
                  aria-label={`${formatDayLong(day)}, ${list.length} Termin${list.length === 1 ? '' : 'e'}`}
                  aria-selected={sameDay(day, selected)}
                  onClick={() => setSelected(day)}
                  onDoubleClick={() => setEditing({ id: null, draft: {} })}
                >
                  <span className="calendar-day-number">{day.getDate()}</span>
                  <span className="calendar-day-events">
                    {list.slice(0, CHIPS_PER_DAY).map((event) => (
                      <span
                        key={event.id}
                        className={`calendar-chip${event.allDay ? ' calendar-chip--allday' : ''}`}
                      >
                        {event.allDay ? '' : `${formatTime(Math.max(event.start, day.getTime()))} `}
                        {event.title}
                      </span>
                    ))}
                    {list.length > CHIPS_PER_DAY ? (
                      <span className="calendar-more">+{list.length - CHIPS_PER_DAY}</span>
                    ) : null}
                  </span>
                  {/* Auf dem Handy ist im Feld kein Platz für Text — dort ein Punkt. */}
                  {list.length > 0 ? <span className="calendar-dot" aria-hidden="true" /> : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <section className="calendar-agenda card" aria-label="Termine am gewählten Tag">
        <div className="calendar-agenda-head">
          <h3>
            {sameDay(selected, today) ? 'Heute, ' : ''}
            {formatDayLong(selected)}
          </h3>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => setEditing({ id: null, draft: {} })}
          >
            + Termin
          </button>
        </div>
        {selectedEvents.length > 0 ? (
          <ul className="calendar-events">{selectedEvents.map((event) => eventRow(event, selected))}</ul>
        ) : (
          <p className="muted small">{loaded ? 'Nichts eingetragen.' : 'Termine werden geladen…'}</p>
        )}
      </section>

      {upcoming.length > 0 ? (
        <section className="calendar-agenda card" aria-label="Danach">
          <h3>Danach</h3>
          {upcoming.map(({ day, events: list }) => (
            <div key={day.getTime()} className="calendar-upcoming-day">
              <button type="button" className="calendar-upcoming-date" onClick={() => show(day)}>
                {formatDayLong(day)}
              </button>
              <ul className="calendar-events">{list.map((event) => eventRow(event, day))}</ul>
            </div>
          ))}
        </section>
      ) : null}

      {editing ? (
        <EventDialog
          // Ein anderer Termin ist ein anderes Formular — sonst blieben die
          // Eingaben des vorigen stehen.
          key={editing.id ?? 'neu'}
          uid={uid}
          editing={editing}
          events={events}
          fallbackDay={selected}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {subscribing ? <SubscribeDialog uid={uid} onClose={() => setSubscribing(false)} /> : null}
    </div>
  )
}
