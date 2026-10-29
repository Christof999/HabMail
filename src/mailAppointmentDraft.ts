import type { EmailRow, MailAppointment } from './types'
import { remindersOf, type CalendarEvent, type CalendarEventInput } from './calendar'

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
      reminders: existing !== null && remindersOf(existing).length > 0
        ? remindersOf(existing)
        : [appointment.allDay ? -480 : 30],
    },
  }
}
