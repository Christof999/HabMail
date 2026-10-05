/**
 * Der Termin an einer Mail.
 *
 * Eine Einladung oder ein Vorschlag der KI. Daneben der Abgleich mit dem
 * Kalender: schon eingetragen, Zeiten geändert, oder etwas steht im Weg.
 * Eingetragen wird erst, wenn der Mensch im Formular speichert.
 */
import type { EmailRow, MailAppointment } from './types'
import {
  formatDayLong,
  formatWhen,
  matchAppointment,
  sameDay,
  type CalendarEvent,
  type CalendarEventInput,
} from './calendar'

function whenLabel(appointment: MailAppointment): string {
  const event: CalendarEvent = {
    id: '',
    title: appointment.title,
    start: appointment.start,
    end: appointment.end,
    allDay: appointment.allDay,
  }
  const start = new Date(appointment.start)
  const end = new Date(appointment.allDay ? appointment.end - 1 : appointment.end)
  if (!sameDay(start, end)) return formatWhen(event)
  return appointment.allDay
    ? `${formatDayLong(start)}, ganztägig`
    : `${formatDayLong(start)}, ${formatWhen(event)}`
}

function notesFor(row: EmailRow, appointment: MailAppointment): string {
  return [
    appointment.organizer ? `Einladung von ${appointment.organizer}` : null,
    `Aus der Mail „${row.subject || 'ohne Betreff'}"`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/** Was das Formular öffnet: den bestehenden Termin, oder einen neuen aus der Mail. */
export function draftForAppointment(
  row: EmailRow,
  appointment: MailAppointment,
  existing: CalendarEvent | null,
  changed: boolean,
): { eventId: string | null; draft: CalendarEventInput } {
  if (existing !== null && !changed) {
    const { id, ...draft } = existing
    return { eventId: id, draft }
  }

  const notes = existing?.notes || notesFor(row, appointment)
  return {
    eventId: existing?.id ?? null,
    draft: {
      title: appointment.title,
      start: appointment.start,
      end: appointment.end,
      allDay: appointment.allDay,
      ...(appointment.location
        ? { location: appointment.location }
        : existing?.location
          ? { location: existing.location }
          : {}),
      ...(notes ? { notes } : {}),
      emailId: existing?.emailId ?? row.id,
      ...(appointment.uid
        ? { icalUid: appointment.uid }
        : existing?.icalUid
          ? { icalUid: existing.icalUid }
          : {}),
      reminderMinutes: existing?.reminderMinutes ?? (appointment.allDay ? -480 : 30),
    },
  }
}

/**
 * Je Einladung nur die neueste Mail. Ein Vorschlag ohne UID bleibt an seiner
 * Mail hängen, den gibt es nur einmal.
 */
function offersIn(rows: EmailRow[]): { row: EmailRow; appointment: MailAppointment }[] {
  const seen = new Set<string>()
  const offers: { row: EmailRow; appointment: MailAppointment }[] = []
  for (const row of rows) {
    const appointment = row.appointment
    if (appointment === undefined) continue
    const key = appointment.uid ?? row.id
    if (seen.has(key)) continue
    seen.add(key)
    offers.push({ row, appointment })
  }
  return offers
}

export default function MailAppointments({
  rows,
  events,
  onOpen,
}: {
  rows: EmailRow[]
  events: CalendarEvent[]
  onOpen: (eventId: string | null, draft: CalendarEventInput) => void
}) {
  const offers = offersIn(rows)
  if (offers.length === 0) return null

  return (
    <div className="mail-appointments">
      {offers.map(({ row, appointment }) => (
        <AppointmentOffer
          key={appointment.uid ?? row.id}
          row={row}
          appointment={appointment}
          events={events}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

function AppointmentOffer({
  row,
  appointment,
  events,
  onOpen,
}: {
  row: EmailRow
  appointment: MailAppointment
  events: CalendarEvent[]
  onOpen: (eventId: string | null, draft: CalendarEventInput) => void
}) {
  const { existing, changed, overlaps } = matchAppointment(events, row.id, appointment)
  const cancelled = appointment.cancelled === true
  // Eine Absage öffnet den bestehenden Termin, statt seine Zeiten zu überschreiben.
  const applyChange = existing !== null && changed && !cancelled

  let kicker = appointment.source === 'einladung' ? 'Einladung' : 'Terminvorschlag'
  if (cancelled) kicker = 'Einladung abgesagt'
  else if (appointment.recurring) kicker += ' · wiederholt sich'

  let status: string | null = null
  if (cancelled && existing !== null) {
    status = 'Im Kalender steht der Termin noch.'
  } else if (existing !== null && changed) {
    status = 'Die Zeiten in der Mail weichen vom Kalender ab.'
  } else if (existing !== null) {
    status = 'Steht im Kalender.'
  } else if (overlaps.length > 0) {
    const names = overlaps.map((event) => event.title).join(', ')
    status = `Überschneidet sich mit ${names}.`
  } else if (appointment.recurring) {
    status = 'Eingetragen wird nur dieser eine Termin.'
  } else if (appointment.source === 'ki') {
    status = 'Aus dem Mailtext gelesen.'
  }

  const buttonLabel =
    existing !== null
      ? applyChange
        ? 'Kalender anpassen'
        : 'Im Kalender öffnen'
      : cancelled
        ? 'Trotzdem eintragen'
        : 'In den Kalender'

  function open() {
    const next = draftForAppointment(row, appointment, existing, applyChange)
    onOpen(next.eventId, next.draft)
  }

  return (
    <aside
      className={`mail-appointment${cancelled ? ' mail-appointment--cancelled' : ''}`}
      data-testid="mail-appointment"
      data-appointment-source={appointment.source}
    >
      <p className="mail-appointment-kicker">{kicker}</p>
      <p className="mail-appointment-title">{appointment.title}</p>
      <p className="muted small mail-appointment-when">
        {whenLabel(appointment)}
        {appointment.location ? ` · ${appointment.location}` : ''}
      </p>
      {appointment.organizer ? (
        <p className="muted small">Von {appointment.organizer}</p>
      ) : null}
      {status ? (
        <p className="mail-appointment-status small" role="status">
          {status}
        </p>
      ) : null}
      <div className="mail-appointment-actions">
        <button
          type="button"
          className={cancelled && existing === null ? 'ghost small-btn' : 'small-btn'}
          data-testid="mail-appointment-open"
          onClick={open}
        >
          {buttonLabel}
        </button>
      </div>
    </aside>
  )
}
