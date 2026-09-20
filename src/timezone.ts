/**
 * Timezone arithmetic, built on Intl rather than a date library.
 *
 * The rule the whole app follows: an instant is a `Date` (UTC underneath), and
 * a *wall time* ("09:30 on 8 March, in New York") is only ever a triple of
 * civil fields plus an IANA zone. Converting between the two is the only place
 * daylight saving can bite, so it all lives here.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The civil (wall-clock) fields an instant shows in a given zone. */
export function toWallTime(instant: Date, timeZone: string): WallTime & { second: number } {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds still render midnight as hour 24 under h23.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of a zone from UTC, in minutes, at a particular instant. */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const wall = toWallTime(instant, timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Round to the second to shake off the milliseconds Intl drops.
  return Math.round((asIfUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * Turn a wall time in a zone into the instant it names.
 *
 * Returns null when that wall time does not exist: on the spring-forward day
 * the clocks jump from 01:59 to 03:00, so "02:30 in New York on 8 March 2026"
 * is not a time. Callers skip those slots rather than quietly offering a
 * meeting at an hour that never happens.
 *
 * On the autumn ambiguity (01:30 happens twice) this returns the *first*,
 * still-in-DST occurrence, which is the one a person means when they look at a
 * calendar.
 */
export function wallTimeToInstant(wall: WallTime, timeZone: string): Date | null {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  // First guess using the offset in force at the naive instant, then correct
  // once using the offset actually in force at the guessed instant. Two passes
  // is enough for every real zone: offsets change by at most a couple of hours.
  let instant = new Date(naive - offsetMinutesAt(new Date(naive), timeZone) * 60000);
  instant = new Date(naive - offsetMinutesAt(instant, timeZone) * 60000);

  // Round-trip check. If the instant we produced does not display as the wall
  // time we were asked for, that wall time was skipped by a DST jump.
  const check = toWallTime(instant, timeZone);
  if (
    check.year !== wall.year ||
    check.month !== wall.month ||
    check.day !== wall.day ||
    check.hour !== wall.hour ||
    check.minute !== wall.minute
  ) {
    return null;
  }
  return instant;
}

/** 'YYYY-MM-DD' as shown in the given zone. */
export function toDateKey(instant: Date, timeZone: string): string {
  const wall = toWallTime(instant, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 31 February and friends.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Day-of-week (0 = Sunday) of a date key, independent of any zone. */
export function weekdayOf(dateKey: string): number {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
}

/** Minutes since midnight, from 'HH:MM'. */
export function parseClock(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatClock(minutesSinceMidnight: number): string {
  const total = ((minutesSinceMidnight % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60), 2)}:${pad(total % 60, 2)}`;
}

/** e.g. "GMT+9" / "GMT-4" — what to show next to a time. */
export function zoneAbbreviation(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(instant);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
