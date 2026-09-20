import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { query } from '../src/db.js';
import { closeDatabase, resetDatabase } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { AppError } from '../src/errors.js';
import {
  availableSlots,
  cancelBooking,
  createBooking,
  createEventType,
  createHost,
  getBookingByToken,
  listBookings,
  replaceRules,
  upsertOverride,
  type EventType,
  type Host,
} from '../src/scheduling.js';

const NOW = new Date('2026-06-10T12:00:00Z'); // a Wednesday

async function seedHost(timeZone = 'America/New_York'): Promise<{ host: Host; eventType: EventType }> {
  const host = await createHost({
    email: 'priya@example.com',
    passwordHash: await hashPassword('correct horse'),
    name: 'Priya Raman',
    slug: 'priya',
    timeZone,
  });
  // Mondays 09:00-11:00 local.
  await replaceRules(host.id, [{ weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 }]);
  const eventType = await createEventType({
    hostId: host.id,
    title: 'Intro call',
    durationMinutes: 30,
    minNoticeMinutes: 0,
  });
  return { host, eventType };
}

beforeEach(resetDatabase);
after(closeDatabase);

test('a visitor is offered the host’s local hours as UTC instants', async () => {
  const { host, eventType } = await seedHost();
  const slots = await availableSlots({ host, eventType, fromDateKey: '2026-06-15', days: 1, now: NOW });
  assert.deepEqual(
    slots.map((s) => s.startsAt.toISOString()),
    [
      '2026-06-15T13:00:00.000Z',
      '2026-06-15T13:30:00.000Z',
      '2026-06-15T14:00:00.000Z',
      '2026-06-15T14:30:00.000Z',
    ],
  );
});

test('booking a slot removes it from what is offered next', async () => {
  const { host, eventType } = await seedHost();
  await createBooking({
    host,
    eventType,
    startsAt: new Date('2026-06-15T13:30:00Z'),
    inviteeName: 'Ada Lovelace',
    inviteeEmail: 'ada@example.com',
    inviteeTimeZone: 'Europe/London',
    now: NOW,
  });
  const slots = await availableSlots({ host, eventType, fromDateKey: '2026-06-15', days: 1, now: NOW });
  assert.deepEqual(slots.map((s) => s.hostClock), ['09:00', '10:00', '10:30']);
});

test('two people booking the same slot within milliseconds: exactly one wins', async () => {
  const { host, eventType } = await seedHost();
  const startsAt = new Date('2026-06-15T13:00:00Z');

  const attempt = (name: string) =>
    createBooking({
      host,
      eventType,
      startsAt,
      inviteeName: name,
      inviteeEmail: `${name.toLowerCase()}@example.com`,
      inviteeTimeZone: 'UTC',
      now: NOW,
    });

  const results = await Promise.allSettled([attempt('Ada'), attempt('Grace')]);
  const winners = results.filter((r) => r.status === 'fulfilled');
  const losers = results.filter((r) => r.status === 'rejected');

  assert.equal(winners.length, 1, 'exactly one booking should be created');
  assert.equal(losers.length, 1, 'the other must be rejected');
  const error = (losers[0] as PromiseRejectedResult).reason as AppError;
  assert.equal(error.code, 'CONFLICT');
  assert.match(error.message, /someone just booked/i);

  const stored = await listBookings(host.id, { upcoming: true, now: NOW });
  assert.equal(stored.length, 1, 'the database must hold exactly one booking for that slot');
});

test('ten simultaneous attempts on one slot still leave one booking', async () => {
  const { host, eventType } = await seedHost();
  const startsAt = new Date('2026-06-15T14:00:00Z');

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) =>
      createBooking({
        host,
        eventType,
        startsAt,
        inviteeName: `Person ${index}`,
        inviteeEmail: `person${index}@example.com`,
        inviteeTimeZone: 'UTC',
        now: NOW,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter((r) => r.status === 'rejected' && (r.reason as AppError).code === 'CONFLICT').length,
    9,
  );
  assert.equal((await listBookings(host.id, { upcoming: true, now: NOW })).length, 1);
});

test('overlapping — not identical — bookings are also rejected', async () => {
  const { host, eventType } = await seedHost();
  const long = await createEventType({
    hostId: host.id,
    title: 'Deep dive',
    durationMinutes: 60,
    incrementMinutes: 30,
    minNoticeMinutes: 0,
  });
  await createBooking({
    host,
    eventType: long,
    startsAt: new Date('2026-06-15T13:00:00Z'), // 13:00-14:00
    inviteeName: 'Ada',
    inviteeEmail: 'ada@example.com',
    inviteeTimeZone: 'UTC',
    now: NOW,
  });
  // A 30-minute booking at 13:30 sits inside it. The slot generator already
  // hides it, so this asserts the constraint would stop a forged request too.
  await assert.rejects(
    () =>
      createBooking({
        host,
        eventType,
        startsAt: new Date('2026-06-15T13:30:00Z'),
        inviteeName: 'Grace',
        inviteeEmail: 'grace@example.com',
        inviteeTimeZone: 'UTC',
        now: NOW,
      }),
    (error: AppError) => error.code === 'INVALID' || error.code === 'CONFLICT',
  );
});

test('back-to-back bookings are allowed — the ranges touch but do not overlap', async () => {
  const { host, eventType } = await seedHost();
  const first = await createBooking({
    host,
    eventType,
    startsAt: new Date('2026-06-15T13:00:00Z'),
    inviteeName: 'Ada',
    inviteeEmail: 'ada@example.com',
    inviteeTimeZone: 'UTC',
    now: NOW,
  });
  const second = await createBooking({
    host,
    eventType,
    startsAt: new Date('2026-06-15T13:30:00Z'),
    inviteeName: 'Grace',
    inviteeEmail: 'grace@example.com',
    inviteeTimeZone: 'UTC',
    now: NOW,
  });
  assert.equal(first.endsAt.getTime(), second.startsAt.getTime());
});

test('cancelling frees the slot for someone else', async () => {
  const { host, eventType } = await seedHost();
  const startsAt = new Date('2026-06-15T13:00:00Z');
  const booking = await createBooking({
    host,
    eventType,
    startsAt,
    inviteeName: 'Ada',
    inviteeEmail: 'ada@example.com',
    inviteeTimeZone: 'UTC',
    now: NOW,
  });

  await cancelBooking(booking.cancelToken);
  const cancelled = await getBookingByToken(booking.cancelToken);
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.sequence, 1, 'the sequence bump is what updates the calendar invite');

  // The exclusion constraint is scoped to confirmed bookings, so the slot is
  // free again — both for the generator and for the insert.
  const slots = await availableSlots({ host, eventType, fromDateKey: '2026-06-15', days: 1, now: NOW });
  assert.ok(slots.some((s) => s.startsAt.getTime() === startsAt.getTime()));
  const rebooked = await createBooking({
    host,
    eventType,
    startsAt,
    inviteeName: 'Grace',
    inviteeEmail: 'grace@example.com',
    inviteeTimeZone: 'UTC',
    now: NOW,
  });
  assert.equal(rebooked.startsAt.getTime(), startsAt.getTime());
});

test('cancelling twice is refused rather than silently repeated', async () => {
  const { host, eventType } = await seedHost();
  const booking = await createBooking({
    host,
    eventType,
    startsAt: new Date('2026-06-15T13:00:00Z'),
    inviteeName: 'Ada',
    inviteeEmail: 'ada@example.com',
    inviteeTimeZone: 'UTC',
    now: NOW,
  });
  await cancelBooking(booking.cancelToken);
  await assert.rejects(() => cancelBooking(booking.cancelToken), (e: AppError) => e.code === 'CONFLICT');
  await assert.rejects(() => cancelBooking('nonsense-token'), (e: AppError) => e.code === 'NOT_FOUND');
});

test('a forged time that no rule offers is refused', async () => {
  const { host, eventType } = await seedHost();
  await assert.rejects(
    () =>
      createBooking({
        host,
        eventType,
        startsAt: new Date('2026-06-15T07:00:00Z'), // 03:00 in New York
        inviteeName: 'Night Owl',
        inviteeEmail: 'owl@example.com',
        inviteeTimeZone: 'UTC',
        now: NOW,
      }),
    (error: AppError) => {
      assert.equal(error.code, 'INVALID');
      assert.match(error.message, /not available/i);
      return true;
    },
  );
});

test('a booking made in one zone reads correctly in another', async () => {
  const { host, eventType } = await seedHost();
  const booking = await createBooking({
    host,
    eventType,
    startsAt: new Date('2026-06-15T13:00:00Z'),
    inviteeName: 'Kenji',
    inviteeEmail: 'kenji@example.com',
    inviteeTimeZone: 'Asia/Tokyo',
    now: NOW,
  });
  // Stored as an instant, so both parties can render it in their own zone.
  assert.equal(booking.startsAt.toISOString(), '2026-06-15T13:00:00.000Z');
  assert.equal(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(
      booking.startsAt,
    ),
    '22:00',
  );
  assert.equal(booking.inviteeTimeZone, 'Asia/Tokyo');
});

test('a blocked date override hides a whole day', async () => {
  const { host, eventType } = await seedHost();
  await upsertOverride(host.id, { dateKey: '2026-06-15', blocked: true });
  const slots = await availableSlots({ host, eventType, fromDateKey: '2026-06-15', days: 1, now: NOW });
  assert.equal(slots.length, 0);
});

test('passwords are salted, verified and not comparable by string', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, second, 'the same password must not produce the same hash');
});

test('the constraint, not the application check, is what makes the race safe', async () => {
  // The service re-checks availability before inserting, which handles most
  // collisions. This test goes around that check and fires two raw inserts at
  // the same instant, which is exactly what two application processes racing
  // each other look like. Only the database can settle it.
  const { host, eventType } = await seedHost();
  const startsAt = new Date('2026-06-15T13:00:00Z');
  const endsAt = new Date('2026-06-15T13:30:00Z');

  const rawInsert = (name: string) =>
    query(
      `INSERT INTO bookings
         (host_id, event_type_id, starts_at, ends_at, invitee_name, invitee_email, invitee_time_zone, cancel_token)
       VALUES ($1, $2, $3, $4, $5, $6, 'UTC', $7)`,
      [host.id, eventType.id, startsAt, endsAt, name, `${name}@example.com`, `token-${name}`],
    );

  const results = await Promise.allSettled([rawInsert('ada'), rawInsert('grace')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejection = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(
    (rejection.reason as { code?: string }).code,
    '23P01',
    'the second insert must fail with exclusion_violation',
  );

  // And a partial overlap is refused too, not just an identical range.
  await assert.rejects(
    () =>
      query(
        `INSERT INTO bookings
           (host_id, event_type_id, starts_at, ends_at, invitee_name, invitee_email, invitee_time_zone, cancel_token)
         VALUES ($1, $2, $3, $4, 'Overlapper', 'over@example.com', 'UTC', 'token-over')`,
        [host.id, eventType.id, new Date('2026-06-15T13:15:00Z'), new Date('2026-06-15T13:45:00Z')],
      ),
    (error: { code?: string }) => error.code === '23P01',
  );

  // A different host at the same instant is fine — the constraint is per host.
  const other = await createHost({
    email: 'other@example.com',
    passwordHash: 'scrypt$00$00',
    name: 'Other Host',
    slug: 'other',
    timeZone: 'UTC',
  });
  const otherEvent = await createEventType({ hostId: other.id, title: 'Chat', durationMinutes: 30 });
  await query(
    `INSERT INTO bookings
       (host_id, event_type_id, starts_at, ends_at, invitee_name, invitee_email, invitee_time_zone, cancel_token)
     VALUES ($1, $2, $3, $4, 'Someone', 'someone@example.com', 'UTC', 'token-other')`,
    [other.id, otherEvent.id, startsAt, endsAt],
  );
});
