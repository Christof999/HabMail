/**
 * Der Kalender einer Person.
 *
 * Termine liegen unter `users/<uid>/calendar/events` — an der Person, nicht am
 * Posteingang: den teilt sich ein Büro, den Kalender nicht. Anlegen und ändern
 * kann sie der Browser selbst; der Server kommt nur für das dazu, was ohne
 * offenes Fenster passieren muss (Erinnerungen, Abo-Link, Agenten — siehe
 * `functions/calendar.js`).
 */
import { get, onValue, push, ref, set, update } from 'firebase/database'
import { getFirebaseDb } from './firebase'
import {
  CALENDAR_REMINDERS_PATH,
  userCalendarEventsPath,
  userCalendarFeedTokenPath,
} from './paths'

export type CalendarEvent = {
  id: string
  title: string
  /** Zeitpunkte in Millisekunden. Ganztägig: Mitternacht bis Mitternacht danach. */
  start: number
  end: number
  allDay: boolean
  location?: string
  notes?: string
  /**
   * Minuten vor dem Anfang. Negativ heißt danach — „um 8 Uhr am selben Tag".
   * Eine einzelne Erinnerung aus älteren Terminen. Mehrere stehen in `reminders`.
   */
  reminderMinutes?: number
  /** Mehrere Erinnerungen, Minuten vor dem Anfang. Die früheste zuerst. */
  reminders?: number[]
  /** Die Mail, aus der der Termin stammt. */
  emailId?: string
  /** UID einer Einladung. Eine spätere Mail zur selben Einladung trifft diesen Termin. */
  icalUid?: string
}

export type CalendarEventInput = Omit<CalendarEvent, 'id'>

const MINUTE = 60_000

export function parseEventsTree(data: unknown): CalendarEvent[] {
  if (data === null || typeof data !== 'object') return []
  const events: CalendarEvent[] = []
  for (const [id, raw] of Object.entries(data as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    if (typeof o.start !== 'number' || typeof o.end !== 'number') continue
    events.push({
      id,
      title: typeof o.title === 'string' ? o.title : '(ohne Titel)',
      start: o.start,
      end: o.end,
      allDay: o.allDay === true,
      ...(typeof o.location === 'string' && o.location !== '' ? { location: o.location } : {}),
      ...(typeof o.notes === 'string' && o.notes !== '' ? { notes: o.notes } : {}),
      ...(typeof o.reminderMinutes === 'number' ? { reminderMinutes: o.reminderMinutes } : {}),
      ...readReminders(o),
      ...(typeof o.emailId === 'string' ? { emailId: o.emailId } : {}),
      ...(typeof o.icalUid === 'string' && o.icalUid !== '' ? { icalUid: o.icalUid } : {}),
    })
  }
  return events.sort((a, b) => a.start - b.start)
}

export function watchEvents(
  uid: string,
  onEvents: (events: CalendarEvent[]) => void,
  onError: (message: string) => void,
): () => void {
  return onValue(
    ref(getFirebaseDb(), userCalendarEventsPath(uid)),
    (snap) => onEvents(parseEventsTree(snap.val())),
    (error) => onError(error.message),
  )
}

/**
 * Termin und Erinnerung in einem Schreibzugriff.
 *
 * Die Erinnerung steht in einer eigenen Warteschlange, nach Zeit sortiert —
 * der Server sieht dort jede Minute nach, ohne jeden Kalender zu lesen. Wer
 * den Termin schreibt, hält sie aktuell; beides zusammen, damit nie eine
 * Erinnerung zu einem Termin übrig bleibt, den es so nicht mehr gibt.
 */
function writes(
  uid: string,
  id: string,
  event: CalendarEventInput | null,
  previous: number[] = [],
): Record<string, unknown> {
  const eventPath = `${userCalendarEventsPath(uid)}/${id}`
  const updates: Record<string, unknown> = {
    [eventPath]: event,
    // Der alte Schlüssel ohne Zeit — eine Erinnerung je Termin. Sonst bliebe
    // er neben den neuen liegen und käme ein zweites Mal.
    [`${CALENDAR_REMINDERS_PATH}/${uid}_${id}`]: null,
  }
  const next = event === null ? [] : remindersOf(event)
  for (const minutes of new Set([...previous, ...next])) {
    updates[reminderQueueKey(uid, id, minutes)] = null
  }
  if (event !== null) {
    const now = Date.now()
    for (const minutes of next) {
      const at = event.start - minutes * MINUTE
      if (at > now) updates[reminderQueueKey(uid, id, minutes)] = { uid, eventId: id, at }
    }
  }
  return updates
}

/** Legt an oder ändert. Gibt die Kennung des Termins zurück. */
export async function saveEvent(
  uid: string,
  id: string | null,
  input: CalendarEventInput,
  existing?: { createdAt?: number; reminders?: number[] },
): Promise<string> {
  const db = getFirebaseDb()
  const key = id ?? push(ref(db, userCalendarEventsPath(uid))).key
  if (key === null) throw new Error('Der Termin ließ sich nicht anlegen.')

  const now = Date.now()
  // Leere Felder weglassen — die Datenbank kennt kein „leer", und die Regeln
  // lehnen alles ab, was nicht dem Format entspricht.
  const record: Record<string, unknown> = {
    title: input.title.trim().slice(0, 200),
    start: input.start,
    end: input.end,
    allDay: input.allDay,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    source: 'habmail',
  }
  if (input.location?.trim()) record.location = input.location.trim().slice(0, 300)
  if (input.notes?.trim()) record.notes = input.notes.trim().slice(0, 4000)
  const reminders = remindersOf(input)
  if (reminders.length > 0) {
    record.reminders = reminders
    // Eine einzelne bleibt auch unter dem alten Feld lesbar.
    if (reminders.length === 1) record.reminderMinutes = reminders[0]
  }
  if (input.emailId) record.emailId = input.emailId
  if (input.icalUid) record.icalUid = input.icalUid.slice(0, 300)

  await update(ref(db), writes(uid, key, record as unknown as CalendarEventInput, existing?.reminders ?? []))
  return key
}

export async function deleteEvent(uid: string, id: string, previousReminders: number[] = []): Promise<void> {
  await update(ref(getFirebaseDb()), writes(uid, id, null, previousReminders))
}

/* ---------------------------------------------------------------- Abo-Link */

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Das Zufallswort im Abo-Link; beim ersten Mal wird eines erzeugt. */
export async function feedToken(uid: string, { renew = false } = {}): Promise<string> {
  const tokenRef = ref(getFirebaseDb(), userCalendarFeedTokenPath(uid))
  if (!renew) {
    const current: unknown = (await get(tokenRef)).val()
    if (typeof current === 'string' && current.length >= 20) return current
  }
  const token = randomToken()
  await set(tokenRef, token)
  return token
}

/**
 * Die Adresse, die ein Kalenderprogramm abonniert. `webcal:` statt `https:`
 * lässt iPhone und Mac gleich „Kalender abonnieren?" fragen.
 */
export function feedUrl(uid: string, token: string, scheme: 'https' | 'webcal' = 'https'): string {
  const project = (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '').trim()
  return (
    `${scheme}://europe-west1-${project}.cloudfunctions.net/calendarFeed` +
    `?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}`
  )
}

/* ------------------------------------------------------------ Tage, Monate */

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

/** Die Wochen eines Monats, Montag zuerst, aufgefüllt mit den Tagen davor und danach. */
export function monthWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1)
  // getDay(): Sonntag ist 0. Montag soll vorne stehen.
  let day = addDays(first, -((first.getDay() + 6) % 7))
  const weeks: Date[][] = []
  do {
    const week: Date[] = []
    for (let i = 0; i < 7; i += 1) {
      week.push(day)
      day = addDays(day, 1)
    }
    weeks.push(week)
  } while (day.getMonth() === month && day.getFullYear() === year)
  return weeks
}

/** Termine, die diesen Tag berühren — auch mehrtägige, die früher anfingen. */
export function eventsOnDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const from = startOfDay(day).getTime()
  const to = addDays(day, 1).getTime()
  return events.filter((e) => e.start < to && e.end > from)
}

/**
 * Was eine Mail anbietet, gemessen am Kalender.
 *
 * `existing` ist der Termin, der schon zu dieser Mail oder zu derselben
 * Einladung gehört. `changed` heißt: die Mail nennt andere Zeiten als der
 * Kalender. `overlaps` sind andere Termine, die im Weg stehen — ganztägige
 * zählen dabei nicht, wie auch sonst im Kalender.
 */
export function matchAppointment(
  events: CalendarEvent[],
  emailId: string,
  appointment: { start: number; end: number; allDay: boolean; uid?: string },
): { existing: CalendarEvent | null; changed: boolean; overlaps: CalendarEvent[] } {
  const byMail = events.find((event) => event.emailId === emailId)
  const byUid =
    appointment.uid === undefined ? undefined : events.find((event) => event.icalUid === appointment.uid)
  const existing = byMail ?? byUid ?? null
  const changed =
    existing !== null &&
    (existing.start !== appointment.start ||
      existing.end !== appointment.end ||
      existing.allDay !== appointment.allDay)
  const overlaps = appointment.allDay
    ? []
    : overlapping(events, appointment.start, appointment.end, existing?.id)
  return { existing, changed, overlaps }
}

/** Was sich mit diesem Zeitraum überschneidet. Ganztägiges zählt nicht als Kollision. */
export function overlapping(
  events: CalendarEvent[],
  start: number,
  end: number,
  exceptId?: string | null,
): CalendarEvent[] {
  return events.filter((e) => e.id !== exceptId && !e.allDay && e.start < end && e.end > start)
}

/* --------------------------------------------------------------- Anzeigen */

const TIME = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' })
const DAY_LONG = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
const DAY_SHORT = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })

export function formatTime(ms: number): string {
  return TIME.format(new Date(ms))
}

export function formatDayLong(date: Date): string {
  return DAY_LONG.format(date)
}

/** „14:00 – 15:30", „ganztägig" oder bei mehreren Tagen mit Datum. */
export function formatWhen(event: CalendarEvent, day?: Date): string {
  if (event.allDay) {
    const last = new Date(event.end - 1)
    const first = new Date(event.start)
    return sameDay(first, last)
      ? 'ganztägig'
      : `ganztägig, ${DAY_SHORT.format(first)} – ${DAY_SHORT.format(last)}`
  }
  const start = new Date(event.start)
  const end = new Date(event.end)
  if (sameDay(start, end)) return `${formatTime(event.start)} – ${formatTime(event.end)}`
  // Über Mitternacht: auf dem jeweiligen Tag nur zeigen, was dort zählt.
  if (day !== undefined && sameDay(day, start)) return `ab ${formatTime(event.start)}`
  if (day !== undefined && sameDay(day, end)) return `bis ${formatTime(event.end)}`
  return `${DAY_SHORT.format(start)} ${formatTime(event.start)} – ${DAY_SHORT.format(end)} ${formatTime(event.end)}`
}

/* -------------------------------------------------------------- Formulare */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Für `<input type="date">`. */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Für `<input type="time">`. */
export function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Datum und Uhrzeit aus zwei Feldern zu einem Zeitpunkt in der Zeit des Geräts. */
export function fromInputs(date: string, time: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = (time || '00:00').split(':').map(Number)
  return new Date(year, month - 1, day, hour || 0, minute || 0).getTime()
}

/** So viele Erinnerungen trägt ein Termin. Darüber wird die Auswahl unübersichtlich. */
export const MAX_REMINDERS = 8
/** Vier Wochen vorher bis einen Tag danach. */
export const MIN_REMINDER_MINUTES = -1440
export const MAX_REMINDER_MINUTES = 28 * 1440

/** Ganze Minuten, jede Zeit nur einmal, die früheste zuerst. */
export function normalizeReminders(values: number[]): number[] {
  const unique = new Set<number>()
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    const minutes = Math.round(value)
    if (minutes < MIN_REMINDER_MINUTES || minutes > MAX_REMINDER_MINUTES) continue
    unique.add(minutes)
  }
  return [...unique].sort((a, b) => b - a).slice(0, MAX_REMINDERS)
}

/** Die Erinnerungen eines Termins — die Liste, oder der einzelne alte Wert. */
export function remindersOf(event: { reminders?: number[]; reminderMinutes?: number } | null): number[] {
  if (event !== null && Array.isArray(event.reminders) && event.reminders.length > 0) {
    return normalizeReminders(event.reminders)
  }
  if (event !== null && typeof event.reminderMinutes === 'number') return normalizeReminders([event.reminderMinutes])
  return []
}

function readReminders(o: Record<string, unknown>): { reminders: number[] } | Record<string, never> {
  if (!Array.isArray(o.reminders)) return {}
  const reminders = normalizeReminders(o.reminders.filter((value): value is number => typeof value === 'number'))
  return reminders.length > 0 ? { reminders } : {}
}

function reminderQueueKey(uid: string, eventId: string, minutes: number): string {
  return `${CALENDAR_REMINDERS_PATH}/${uid}_${eventId}_${minutes}`
}

/** „1 Tag vorher", „10 Minuten vorher", „6 Stunden danach". */
export function reminderLabel(minutes: number): string {
  if (minutes === 0) return 'Zum Beginn'
  const after = minutes < 0
  const abs = Math.abs(minutes)
  const when = after ? 'danach' : 'vorher'
  if (abs % 1440 === 0) {
    const days = abs / 1440
    return `${days} ${days === 1 ? 'Tag' : 'Tage'} ${when}`
  }
  if (abs % 60 === 0) {
    const hours = abs / 60
    return `${hours} ${hours === 1 ? 'Stunde' : 'Stunden'} ${when}`
  }
  return `${abs} ${abs === 1 ? 'Minute' : 'Minuten'} ${when}`
}

export const REMINDER_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'Zum Beginn' },
  { minutes: 10, label: '10 Minuten vorher' },
  { minutes: 30, label: '30 Minuten vorher' },
  { minutes: 60, label: '1 Stunde vorher' },
  { minutes: 120, label: '2 Stunden vorher' },
  { minutes: 1440, label: '1 Tag vorher' },
]

/** Ganztägige Termine beginnen um Mitternacht — „30 Minuten vorher" weckte niemanden sinnvoll. */
export const ALL_DAY_REMINDER_CHOICES: { minutes: number; label: string }[] = [
  { minutes: -480, label: 'Am Tag um 8 Uhr' },
  { minutes: 360, label: 'Am Vortag um 18 Uhr' },
  { minutes: 960, label: 'Am Vortag um 8 Uhr' },
]
