/**
 * iCalendar (RFC 5545) generation.
 *
 * Small enough to hand-write, and hand-writing it means the awkward details are
 * visible rather than buried in a dependency: CRLF line endings, 75-octet line
 * folding, text escaping, a stable UID so an update replaces the event instead
 * of creating a second one, and METHOD/SEQUENCE so a cancellation actually
 * removes the meeting from the invitee's calendar.
 */

export interface CalendarPerson {
  name: string;
  email: string;
}

export interface CalendarEvent {
  /** Stable for the lifetime of the booking — this is what makes updates work. */
  uid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description: string;
  url?: string;
  organizer: CalendarPerson;
  attendee: CalendarPerson;
  timestamp?: Date;
}

/** RFC 5545 date-time in UTC: 20260615T130000Z */
export function formatIcsDate(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

/** Commas, semicolons, backslashes and newlines are structural in iCalendar. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Content lines are limited to 75 octets, continued by CRLF + a single space.
 * The limit is octets, not characters, so a multi-byte character must not be
 * split across the fold.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const pieces: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off until we are on a UTF-8 character boundary.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    pieces.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return pieces.join('\r\n ');
}

export function buildIcs(event: CalendarEvent): string {
  const cancelled = event.method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotline//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${formatIcsDate(event.timestamp ?? new Date())}`,
    `DTSTART:${formatIcsDate(event.startsAt)}`,
    `DTEND:${formatIcsDate(event.endsAt)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `ORGANIZER;CN=${escapeText(event.organizer.name)}:mailto:${event.organizer.email}`,
    `ATTENDEE;CN=${escapeText(event.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${
      cancelled ? 'DECLINED' : 'ACCEPTED'
    };RSVP=FALSE:mailto:${event.attendee.email}`,
    ...(event.url ? [`URL:${event.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // RFC 5545 requires CRLF, and a trailing one after the final line.
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
