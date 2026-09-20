import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDaysToDateKey,
  formatClock,
  offsetMinutesAt,
  parseClock,
  parseDateKey,
  toDateKey,
  toWallTime,
  wallTimeToInstant,
  weekdayOf,
} from '../src/timezone.js';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const KATHMANDU = 'Asia/Kathmandu'; // UTC+05:45, because 45-minute offsets exist

test('wall time round-trips through UTC', () => {
  const instant = wallTimeToInstant({ year: 2026, month: 6, day: 15, hour: 9, minute: 30 }, NY);
  assert.ok(instant);
  assert.equal(instant.toISOString(), '2026-06-15T13:30:00.000Z'); // EDT, UTC-4
  assert.deepEqual(
    { ...toWallTime(instant, NY), second: undefined },
    { year: 2026, month: 6, day: 15, hour: 9, minute: 30, second: undefined },
  );
});

test('the same instant is a different wall time in every zone', () => {
  const instant = wallTimeToInstant({ year: 2026, month: 6, day: 15, hour: 9, minute: 30 }, NY)!;
  assert.equal(toWallTime(instant, TOKYO).hour, 22);
  assert.equal(toDateKey(instant, TOKYO), '2026-06-15');
  const kathmandu = toWallTime(instant, KATHMANDU);
  assert.equal(`${kathmandu.hour}:${kathmandu.minute}`, '19:15');
});

test('standard time and daylight time give different UTC instants for the same clock time', () => {
  const winter = wallTimeToInstant({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, NY)!;
  const summer = wallTimeToInstant({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, NY)!;
  assert.equal(winter.toISOString(), '2026-01-15T14:00:00.000Z'); // EST, UTC-5
  assert.equal(summer.toISOString(), '2026-07-15T13:00:00.000Z'); // EDT, UTC-4
  assert.equal(offsetMinutesAt(winter, NY), -300);
  assert.equal(offsetMinutesAt(summer, NY), -240);
});

test('spring forward: 02:00-02:59 does not exist in New York on 2026-03-08', () => {
  for (const minute of [0, 15, 30, 45]) {
    assert.equal(
      wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute }, NY),
      null,
      `02:${minute} should not exist`,
    );
  }
  // The hours either side are perfectly ordinary, and one hour apart on the clock
  // but adjacent in UTC.
  const before = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, NY)!;
  const after = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, NY)!;
  assert.equal(before.toISOString(), '2026-03-08T06:30:00.000Z');
  assert.equal(after.toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(after.getTime() - before.getTime(), 60 * 60 * 1000, 'only one real hour passed');
});

test('autumn fall back: the repeated hour resolves to its first occurrence', () => {
  const ambiguous = wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY)!;
  // 01:30 EDT (UTC-4) = 05:30Z, and 01:30 EST (UTC-5) = 06:30Z. We take the earlier.
  assert.equal(ambiguous.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(toWallTime(ambiguous, NY).hour, 1);
});

test('southern-hemisphere DST works in the other direction', () => {
  const sydney = 'Australia/Sydney';
  const jan = wallTimeToInstant({ year: 2026, month: 1, day: 15, hour: 12, minute: 0 }, sydney)!;
  const jul = wallTimeToInstant({ year: 2026, month: 7, day: 15, hour: 12, minute: 0 }, sydney)!;
  assert.equal(offsetMinutesAt(jan, sydney), 660); // UTC+11 in summer
  assert.equal(offsetMinutesAt(jul, sydney), 600); // UTC+10 in winter
});

test('zones without DST are stable all year', () => {
  for (const month of [1, 4, 7, 10]) {
    const instant = wallTimeToInstant({ year: 2026, month, day: 15, hour: 12, minute: 0 }, TOKYO)!;
    assert.equal(offsetMinutesAt(instant, TOKYO), 540);
  }
});

test('a date key is whatever the calendar on the wall says', () => {
  // 2026-06-15 22:00 in Tokyo is still 09:00 on the 15th in New York.
  const instant = wallTimeToInstant({ year: 2026, month: 6, day: 15, hour: 22, minute: 0 }, TOKYO)!;
  assert.equal(toDateKey(instant, TOKYO), '2026-06-15');
  assert.equal(toDateKey(instant, NY), '2026-06-15');
  // An hour later it is the 16th in Tokyo but still the 15th in New York.
  const later = new Date(instant.getTime() + 2 * 60 * 60 * 1000);
  assert.equal(toDateKey(later, TOKYO), '2026-06-16');
  assert.equal(toDateKey(later, NY), '2026-06-15');
});

test('date key helpers handle month and year boundaries', () => {
  assert.equal(addDaysToDateKey('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysToDateKey('2024-02-28', 1), '2024-02-29'); // leap year
  assert.equal(addDaysToDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToDateKey('2026-01-01', -1), '2025-12-31');
  assert.equal(weekdayOf('2026-09-20'), 0); // a Sunday
  assert.equal(parseDateKey('2026-02-30'), null);
  assert.equal(parseDateKey('not-a-date'), null);
});

test('clock parsing and formatting', () => {
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('9:30'), 570);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('09:60'), null);
  assert.equal(formatClock(570), '09:30');
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(1439), '23:59');
});
