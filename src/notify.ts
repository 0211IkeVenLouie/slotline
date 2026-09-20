import { env } from './env.js';
import { formatRange } from './format.js';
import { buildIcs } from './ics.js';
import { createTransport, sendQuietly, type Attachment } from './email.js';
import type { Booking, EventType, Host } from './scheduling.js';

const transport = createTransport();

function icsAttachment(input: {
  booking: Booking;
  host: Host;
  eventType: EventType;
  method: 'REQUEST' | 'CANCEL';
}): Attachment {
  const { booking, host, eventType } = input;
  return {
    filename: 'invite.ics',
    contentType: 'text/calendar; charset=utf-8; method=' + input.method,
    content: buildIcs({
      // Stable across the invitation and the cancellation, so the invitee's
      // calendar updates the same event instead of gaining a second one.
      uid: `${booking.id}@slotline`,
      sequence: booking.sequence,
      method: input.method,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      summary: `${eventType.title} — ${host.name} & ${booking.inviteeName}`,
      description:
        `${eventType.description || eventType.title}\n\n` +
        (booking.notes ? `Notes: ${booking.notes}\n\n` : '') +
        `Manage this booking: ${env.baseUrl}/booking/${booking.cancelToken}`,
      url: `${env.baseUrl}/booking/${booking.cancelToken}`,
      organizer: { name: host.name, email: host.email },
      attendee: { name: booking.inviteeName, email: booking.inviteeEmail },
    }),
  };
}

function layout(title: string, lines: string[], action?: { label: string; href: string }): string {
  return `<!doctype html><html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#16161d; line-height:1.5;">
  <div style="max-width:520px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 16px;font-size:18px;">${title}</h2>
    ${lines.map((line) => `<p style="margin:0 0 12px;">${line}</p>`).join('')}
    ${
      action
        ? `<p style="margin:24px 0 0;"><a href="${action.href}" style="background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block;">${action.label}</a></p>`
        : ''
    }
    <p style="margin:28px 0 0;color:#8d93a1;font-size:13px;">Sent by Slotline.</p>
  </div></body></html>`;
}

export async function sendBookingConfirmation(input: {
  booking: Booking;
  host: Host;
  eventType: EventType;
}): Promise<void> {
  const { booking, host, eventType } = input;
  const inviteeWhen = formatRange(booking.startsAt, booking.endsAt, booking.inviteeTimeZone);
  const hostWhen = formatRange(booking.startsAt, booking.endsAt, host.timeZone);
  const manageUrl = `${env.baseUrl}/booking/${booking.cancelToken}`;

  await sendQuietly(transport, {
    to: booking.inviteeEmail,
    subject: `Confirmed: ${eventType.title} with ${host.name}`,
    text: `Your ${eventType.title} with ${host.name} is confirmed.\n\n${inviteeWhen}\n(That is ${hostWhen} for ${host.name}.)\n\nThe attached invite will add it to your calendar.\nNeed to cancel? ${manageUrl}\n`,
    html: layout(`Your ${eventType.title} with ${host.name} is confirmed`, [
      `<strong>${inviteeWhen}</strong>`,
      `That is ${hostWhen} for ${host.name}.`,
      'The attached invite will add it to your calendar.',
    ], { label: 'View or cancel', href: manageUrl }),
    attachments: [icsAttachment({ booking, host, eventType, method: 'REQUEST' })],
  });

  await sendQuietly(transport, {
    to: host.email,
    subject: `New booking: ${booking.inviteeName} — ${eventType.title}`,
    text: `${booking.inviteeName} (${booking.inviteeEmail}) booked ${eventType.title}.\n\n${hostWhen}\nTheir timezone: ${booking.inviteeTimeZone}\n${booking.notes ? `\nNotes: ${booking.notes}\n` : ''}`,
    html: layout(`${booking.inviteeName} booked ${eventType.title}`, [
      `<strong>${hostWhen}</strong>`,
      `${booking.inviteeEmail} · ${booking.inviteeTimeZone}`,
      ...(booking.notes ? [`Notes: ${booking.notes}`] : []),
    ], { label: 'See your bookings', href: `${env.baseUrl}/app` }),
    attachments: [icsAttachment({ booking, host, eventType, method: 'REQUEST' })],
  });
}

export async function sendCancellation(input: {
  booking: Booking;
  host: Host;
  eventType: EventType;
  cancelledBy: 'invitee' | 'host';
}): Promise<void> {
  const { booking, host, eventType } = input;
  const attachment = icsAttachment({ booking, host, eventType, method: 'CANCEL' });
  const when = formatRange(booking.startsAt, booking.endsAt, booking.inviteeTimeZone);

  await sendQuietly(transport, {
    to: booking.inviteeEmail,
    subject: `Cancelled: ${eventType.title} with ${host.name}`,
    text: `Your ${eventType.title} with ${host.name} on ${when} has been cancelled.\n\nBook another time: ${env.baseUrl}/${host.slug}/${eventType.slug}\n`,
    html: layout(`${eventType.title} cancelled`, [
      `Your meeting with ${host.name} on <strong>${when}</strong> has been cancelled.`,
    ], { label: 'Book another time', href: `${env.baseUrl}/${host.slug}/${eventType.slug}` }),
    attachments: [attachment],
  });

  await sendQuietly(transport, {
    to: host.email,
    subject: `Cancelled: ${booking.inviteeName} — ${eventType.title}`,
    text: `${booking.inviteeName} no longer has ${eventType.title} on ${formatRange(booking.startsAt, booking.endsAt, host.timeZone)}.\n`,
    html: layout('A booking was cancelled', [
      `${booking.inviteeName} — ${eventType.title}`,
      `<strong>${formatRange(booking.startsAt, booking.endsAt, host.timeZone)}</strong>`,
    ]),
    attachments: [attachment],
  });
}

export { buildIcs };
