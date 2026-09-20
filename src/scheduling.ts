import { newCancelToken } from './auth.js';
import { generateSlots, type AvailabilityRule, type DateOverride, type Interval, type Slot } from './availability.js';
import { one, query } from './db.js';
import { AppError } from './errors.js';
import { addDaysToDateKey, isValidTimeZone, parseDateKey, toDateKey } from './timezone.js';

export interface Host {
  id: string;
  email: string;
  name: string;
  slug: string;
  timeZone: string;
  isDemo: boolean;
}

export interface EventType {
  id: string;
  hostId: string;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  incrementMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  advanceDays: number;
  isActive: boolean;
}

export interface Booking {
  id: string;
  hostId: string;
  eventTypeId: string;
  startsAt: Date;
  endsAt: Date;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimeZone: string;
  notes: string;
  status: 'confirmed' | 'cancelled';
  cancelToken: string;
  sequence: number;
}

/* ------------------------------------------------------------------ hosts */

const HOST_COLUMNS = 'id, email, name, slug, time_zone, is_demo';

interface HostRow {
  id: string;
  email: string;
  name: string;
  slug: string;
  time_zone: string;
  is_demo: boolean;
}

function toHost(row: HostRow): Host {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    slug: row.slug,
    timeZone: row.time_zone,
    isDemo: row.is_demo,
  };
}

export async function getHostById(id: string): Promise<Host | undefined> {
  const row = await one<HostRow>(`SELECT ${HOST_COLUMNS} FROM hosts WHERE id = $1`, [id]);
  return row ? toHost(row) : undefined;
}

export async function getHostBySlug(slug: string): Promise<Host | undefined> {
  const row = await one<HostRow>(`SELECT ${HOST_COLUMNS} FROM hosts WHERE slug = $1`, [slug]);
  return row ? toHost(row) : undefined;
}

export async function getHostByEmail(email: string): Promise<(Host & { passwordHash: string }) | undefined> {
  const row = await one<HostRow & { password_hash: string }>(
    `SELECT ${HOST_COLUMNS}, password_hash FROM hosts WHERE lower(email) = lower($1)`,
    [email],
  );
  return row ? { ...toHost(row), passwordHash: row.password_hash } : undefined;
}

export async function getDemoHost(): Promise<Host | undefined> {
  const row = await one<HostRow>(`SELECT ${HOST_COLUMNS} FROM hosts WHERE is_demo = true LIMIT 1`);
  return row ? toHost(row) : undefined;
}

export async function createHost(input: {
  email: string;
  passwordHash: string;
  name: string;
  slug: string;
  timeZone: string;
  isDemo?: boolean;
}): Promise<Host> {
  if (!isValidTimeZone(input.timeZone)) throw new AppError('INVALID', 'That is not a known timezone.');
  const row = await one<HostRow>(
    `INSERT INTO hosts (email, password_hash, name, slug, time_zone, is_demo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${HOST_COLUMNS}`,
    [input.email, input.passwordHash, input.name, input.slug, input.timeZone, input.isDemo ?? false],
  );
  return toHost(row!);
}

export async function updateHostTimeZone(hostId: string, timeZone: string): Promise<void> {
  if (!isValidTimeZone(timeZone)) throw new AppError('INVALID', 'That is not a known timezone.');
  await query('UPDATE hosts SET time_zone = $2 WHERE id = $1', [hostId, timeZone]);
}

/* ------------------------------------------------------------ event types */

const EVENT_COLUMNS = `id, host_id, slug, title, description, duration_minutes, increment_minutes,
  buffer_minutes, min_notice_minutes, advance_days, is_active`;

interface EventTypeRow {
  id: string;
  host_id: string;
  slug: string;
  title: string;
  description: string;
  duration_minutes: number;
  increment_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  advance_days: number;
  is_active: boolean;
}

function toEventType(row: EventTypeRow): EventType {
  return {
    id: row.id,
    hostId: row.host_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    incrementMinutes: row.increment_minutes,
    bufferMinutes: row.buffer_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    advanceDays: row.advance_days,
    isActive: row.is_active,
  };
}

export async function listEventTypes(hostId: string): Promise<EventType[]> {
  const rows = await query<EventTypeRow>(
    `SELECT ${EVENT_COLUMNS} FROM event_types WHERE host_id = $1 ORDER BY duration_minutes, title`,
    [hostId],
  );
  return rows.map(toEventType);
}

export async function getEventType(hostId: string, slug: string): Promise<EventType | undefined> {
  const row = await one<EventTypeRow>(
    `SELECT ${EVENT_COLUMNS} FROM event_types WHERE host_id = $1 AND slug = $2`,
    [hostId, slug],
  );
  return row ? toEventType(row) : undefined;
}

export async function createEventType(input: {
  hostId: string;
  title: string;
  durationMinutes: number;
  description?: string;
  incrementMinutes?: number;
  bufferMinutes?: number;
  minNoticeMinutes?: number;
  slug?: string;
}): Promise<EventType> {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new AppError('INVALID', 'Give the meeting a name.');
  const slug = (input.slug ?? slugify(title)) || `meeting-${input.durationMinutes}`;
  const row = await one<EventTypeRow>(
    `INSERT INTO event_types
       (host_id, slug, title, description, duration_minutes, increment_minutes, buffer_minutes, min_notice_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (host_id, slug) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       duration_minutes = EXCLUDED.duration_minutes,
       increment_minutes = EXCLUDED.increment_minutes,
       buffer_minutes = EXCLUDED.buffer_minutes,
       min_notice_minutes = EXCLUDED.min_notice_minutes
     RETURNING ${EVENT_COLUMNS}`,
    [
      input.hostId,
      slug,
      title,
      (input.description ?? '').trim().slice(0, 500),
      input.durationMinutes,
      input.incrementMinutes ?? Math.min(input.durationMinutes, 30),
      input.bufferMinutes ?? 0,
      input.minNoticeMinutes ?? 60,
    ],
  );
  return toEventType(row!);
}

export async function deleteEventType(hostId: string, eventTypeId: string): Promise<void> {
  await query('DELETE FROM event_types WHERE host_id = $1 AND id = $2', [hostId, eventTypeId]);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/* ----------------------------------------------------------- availability */

export async function listRules(hostId: string): Promise<AvailabilityRule[]> {
  const rows = await query<{ weekday: number; start_minute: number; end_minute: number }>(
    'SELECT weekday, start_minute, end_minute FROM availability_rules WHERE host_id = $1 ORDER BY weekday, start_minute',
    [hostId],
  );
  return rows.map((row) => ({
    weekday: row.weekday,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
  }));
}

export async function replaceRules(hostId: string, rules: AvailabilityRule[]): Promise<void> {
  for (const rule of rules) {
    if (rule.startMinute >= rule.endMinute) {
      throw new AppError('INVALID', 'A day cannot end before it starts.');
    }
  }
  await query('DELETE FROM availability_rules WHERE host_id = $1', [hostId]);
  for (const rule of rules) {
    await query(
      'INSERT INTO availability_rules (host_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4)',
      [hostId, rule.weekday, rule.startMinute, rule.endMinute],
    );
  }
}

export async function listOverrides(hostId: string): Promise<DateOverride[]> {
  const rows = await query<{
    date_key: Date;
    blocked: boolean;
    start_minute: number | null;
    end_minute: number | null;
  }>(
    `SELECT to_char(date_key, 'YYYY-MM-DD') AS date_key, blocked, start_minute, end_minute
       FROM date_overrides WHERE host_id = $1 ORDER BY date_key`,
    [hostId],
  );
  return rows.map((row) => ({
    dateKey: String(row.date_key),
    blocked: row.blocked,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
  }));
}

export async function upsertOverride(hostId: string, override: DateOverride): Promise<void> {
  await query(
    `INSERT INTO date_overrides (host_id, date_key, blocked, start_minute, end_minute)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (host_id, date_key)
     DO UPDATE SET blocked = EXCLUDED.blocked, start_minute = EXCLUDED.start_minute, end_minute = EXCLUDED.end_minute`,
    [hostId, override.dateKey, override.blocked, override.startMinute ?? null, override.endMinute ?? null],
  );
}

export async function deleteOverride(hostId: string, dateKey: string): Promise<void> {
  await query('DELETE FROM date_overrides WHERE host_id = $1 AND date_key = $2', [hostId, dateKey]);
}

/* --------------------------------------------------------------- bookings */

const BOOKING_COLUMNS = `id, host_id, event_type_id, starts_at, ends_at, invitee_name, invitee_email,
  invitee_time_zone, notes, status, cancel_token, sequence`;

interface BookingRow {
  id: string;
  host_id: string;
  event_type_id: string;
  starts_at: Date;
  ends_at: Date;
  invitee_name: string;
  invitee_email: string;
  invitee_time_zone: string;
  notes: string;
  status: 'confirmed' | 'cancelled';
  cancel_token: string;
  sequence: number;
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    hostId: row.host_id,
    eventTypeId: row.event_type_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    inviteeName: row.invitee_name,
    inviteeEmail: row.invitee_email,
    inviteeTimeZone: row.invitee_time_zone,
    notes: row.notes,
    status: row.status,
    cancelToken: row.cancel_token,
    sequence: row.sequence,
  };
}

export async function listBusy(hostId: string, from: Date, to: Date): Promise<Interval[]> {
  const rows = await query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM bookings
      WHERE host_id = $1 AND status = 'confirmed' AND ends_at > $2 AND starts_at < $3`,
    [hostId, from, to],
  );
  return rows.map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at }));
}

/** The slots a visitor may pick from, as UTC instants. */
export async function availableSlots(input: {
  host: Host;
  eventType: EventType;
  fromDateKey?: string;
  days?: number;
  now?: Date;
}): Promise<Slot[]> {
  const now = input.now ?? new Date();
  const fromDateKey = input.fromDateKey ?? toDateKey(now, input.host.timeZone);
  const days = Math.min(input.days ?? input.eventType.advanceDays, 62);

  const [rules, overrides] = await Promise.all([listRules(input.host.id), listOverrides(input.host.id)]);
  // The busy window has to bracket the *requested date range*, not "now" -- a
  // visitor paging forward to next month would otherwise be offered slots that
  // are already booked. Two days of padding either side covers the zone offset
  // and a booking that runs across local midnight.
  const rangeStart = parseDateKey(fromDateKey)!;
  const windowStart = new Date(Date.UTC(rangeStart.year, rangeStart.month - 1, rangeStart.day - 2));
  const windowEnd = new Date(Date.UTC(rangeStart.year, rangeStart.month - 1, rangeStart.day + days + 2));
  const busy = await listBusy(input.host.id, windowStart, windowEnd);

  return generateSlots({
    timeZone: input.host.timeZone,
    rules,
    overrides,
    durationMinutes: input.eventType.durationMinutes,
    incrementMinutes: input.eventType.incrementMinutes,
    bufferMinutes: input.eventType.bufferMinutes,
    minNoticeMinutes: input.eventType.minNoticeMinutes,
    fromDateKey,
    days,
    busy,
    now,
  });
}

export class SlotTakenError extends AppError {
  constructor() {
    super('CONFLICT', 'Sorry — someone just booked that time. Please pick another slot.');
  }
}

/**
 * Book a slot.
 *
 * Two safeguards, doing different jobs:
 *
 * 1. The requested instant is re-derived from the host's availability rather
 *    than trusted from the form, so a hand-crafted POST cannot book 3am.
 * 2. The insert relies on the table's GiST exclusion constraint to reject an
 *    overlap. Checking availability and then inserting is a read-then-write
 *    race; two requests milliseconds apart both pass the check. Only the
 *    database can settle it, and it does so across every application process.
 */
export async function createBooking(input: {
  host: Host;
  eventType: EventType;
  startsAt: Date;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimeZone: string;
  notes?: string;
  now?: Date;
}): Promise<Booking> {
  const now = input.now ?? new Date();
  const name = input.inviteeName.trim().slice(0, 120);
  const email = input.inviteeEmail.trim().slice(0, 200);
  if (!name) throw new AppError('INVALID', 'Please give your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('INVALID', 'That email address does not look right.');
  const timeZone = isValidTimeZone(input.inviteeTimeZone) ? input.inviteeTimeZone : 'UTC';

  const dateKey = toDateKey(input.startsAt, input.host.timeZone);
  const offered = await availableSlots({
    host: input.host,
    eventType: input.eventType,
    // One day either side, because the slot may sit near a local midnight.
    fromDateKey: addDaysToDateKey(dateKey, -1),
    days: 3,
    now,
  });
  const slot = offered.find((candidate) => candidate.startsAt.getTime() === input.startsAt.getTime());
  if (!slot) {
    // "Not offered" has two very different causes, and the visitor deserves to
    // know which: somebody took it while they were filling in the form, or they
    // asked for a time this host never offers.
    const endsAt = new Date(input.startsAt.getTime() + input.eventType.durationMinutes * 60000);
    const clash = await listBusy(input.host.id, input.startsAt, endsAt);
    if (clash.length > 0) throw new SlotTakenError();
    throw new AppError('INVALID', 'That time is not available. Please pick one of the offered slots.');
  }

  try {
    const row = await one<BookingRow>(
      `INSERT INTO bookings
         (host_id, event_type_id, starts_at, ends_at, invitee_name, invitee_email, invitee_time_zone, notes, cancel_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        input.host.id,
        input.eventType.id,
        slot.startsAt,
        slot.endsAt,
        name,
        email,
        timeZone,
        (input.notes ?? '').trim().slice(0, 1000),
        newCancelToken(),
      ],
    );
    return toBooking(row!);
  } catch (error) {
    // 23P01 = exclusion_violation: the slot was taken between the check above
    // and this insert. This is the race the constraint exists for.
    if ((error as { code?: string }).code === '23P01') throw new SlotTakenError();
    throw error;
  }
}

export async function getBookingByToken(token: string): Promise<Booking | undefined> {
  const row = await one<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE cancel_token = $1`, [token]);
  return row ? toBooking(row) : undefined;
}

export async function cancelBooking(token: string): Promise<Booking> {
  const row = await one<BookingRow>(
    `UPDATE bookings
        SET status = 'cancelled', cancelled_at = now(), sequence = sequence + 1
      WHERE cancel_token = $1 AND status = 'confirmed'
      RETURNING ${BOOKING_COLUMNS}`,
    [token],
  );
  if (!row) {
    const existing = await getBookingByToken(token);
    if (existing) throw new AppError('CONFLICT', 'That booking was already cancelled.');
    throw new AppError('NOT_FOUND', 'We could not find that booking.');
  }
  return toBooking(row);
}

export interface BookingWithEvent extends Booking {
  eventTitle: string;
  durationMinutes: number;
}

export async function listBookings(
  hostId: string,
  options: { upcoming: boolean; now?: Date },
): Promise<BookingWithEvent[]> {
  const now = options.now ?? new Date();
  const rows = await query<BookingRow & { title: string; duration_minutes: number }>(
    `SELECT b.id, b.host_id, b.event_type_id, b.starts_at, b.ends_at, b.invitee_name, b.invitee_email,
            b.invitee_time_zone, b.notes, b.status, b.cancel_token, b.sequence,
            e.title, e.duration_minutes
       FROM bookings b
       JOIN event_types e ON e.id = b.event_type_id
      WHERE b.host_id = $1 AND ${options.upcoming ? 'b.ends_at >= $2' : 'b.ends_at < $2'}
      ORDER BY b.starts_at ${options.upcoming ? 'ASC' : 'DESC'}
      LIMIT 200`,
    [hostId, now],
  );
  return rows.map((row) => ({ ...toBooking(row), eventTitle: row.title, durationMinutes: row.duration_minutes }));
}
