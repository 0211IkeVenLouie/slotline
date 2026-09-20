import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { pool, query } from './db.js';
import { migrate } from './migrate.js';
import {
  availableSlots,
  createBooking,
  createEventType,
  createHost,
  getDemoHost,
  replaceRules,
  upsertOverride,
  type Host,
} from './scheduling.js';
import { addDaysToDateKey, toDateKey } from './timezone.js';

export const DEMO_EMAIL = 'demo@slotline.dev';
export const DEMO_PASSWORD = 'demo-password';

const INVITEES = [
  { name: 'Ada Lovelace', email: 'ada@example.com', timeZone: 'Europe/London', notes: 'Happy to go over the API design.' },
  { name: 'Kenji Watanabe', email: 'kenji@example.com', timeZone: 'Asia/Tokyo', notes: '' },
  { name: 'Marta Ruiz', email: 'marta@example.com', timeZone: 'Europe/Madrid', notes: 'Following up on the proposal.' },
  { name: 'Grace Hopper', email: 'grace@example.com', timeZone: 'America/New_York', notes: '' },
];

/**
 * The demo host exists so the product is visible without signing up: the
 * landing page logs you straight in, and the account already has availability,
 * two event types and a few bookings in it.
 */
export async function seedDemoHost(): Promise<Host> {
  const existing = await getDemoHost();
  if (existing) return existing;

  const host = await createHost({
    email: DEMO_EMAIL,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    name: 'Priya Raman',
    slug: 'priya',
    timeZone: 'America/New_York',
    isDemo: true,
  });

  // Monday to Friday, 09:00-12:00 and 13:00-17:00 in the host's own timezone.
  await replaceRules(
    host.id,
    [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
      { weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
    ]),
  );

  const intro = await createEventType({
    hostId: host.id,
    title: 'Intro call',
    slug: 'intro',
    description: 'A short first conversation. Tell me what you are working on.',
    durationMinutes: 30,
    incrementMinutes: 30,
    bufferMinutes: 10,
    minNoticeMinutes: 120,
  });
  await createEventType({
    hostId: host.id,
    title: 'Deep dive',
    slug: 'deep-dive',
    description: 'An hour to go through something properly — architecture, a review, a plan.',
    durationMinutes: 60,
    incrementMinutes: 30,
    bufferMinutes: 15,
    minNoticeMinutes: 24 * 60,
  });

  const now = new Date();
  // A day off next week, so the availability page has something to show.
  await upsertOverride(host.id, { dateKey: addDaysToDateKey(toDateKey(now, host.timeZone), 9), blocked: true });

  // Fill a few of the next available slots so the bookings list is not empty.
  const slots = await availableSlots({ host, eventType: intro, days: 14, now });
  const chosen = [slots[2], slots[7], slots[15], slots[26]].filter(Boolean);
  for (const [index, slot] of chosen.entries()) {
    const invitee = INVITEES[index % INVITEES.length]!;
    try {
      await createBooking({
        host,
        eventType: intro,
        startsAt: slot!.startsAt,
        inviteeName: invitee.name,
        inviteeEmail: invitee.email,
        inviteeTimeZone: invitee.timeZone,
        notes: invitee.notes,
        now,
      });
    } catch (error) {
      console.warn(`Skipped a demo booking: ${(error as Error).message}`);
    }
  }

  // And one in the past, so the "past" tab is not empty either.
  const pastStart = new Date(now.getTime() - 3 * 24 * 3600_000);
  pastStart.setUTCMinutes(0, 0, 0);
  await query(
    `INSERT INTO bookings (host_id, event_type_id, starts_at, ends_at, invitee_name, invitee_email,
                           invitee_time_zone, notes, cancel_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [
      host.id,
      intro.id,
      pastStart,
      new Date(pastStart.getTime() + 30 * 60000),
      'Samir Haddad',
      'samir@example.com',
      'Europe/Berlin',
      'Went through the integration plan.',
      'demo-past-booking-token',
    ],
  );

  console.log(`Seeded demo host: ${DEMO_EMAIL} / ${DEMO_PASSWORD} — public page at /${host.slug}`);
  return host;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  migrate()
    .then(seedDemoHost)
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
