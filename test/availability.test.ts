import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSlots, groupByViewerDate, type SlotQuery } from '../src/availability.js';
import { toWallTime } from '../src/timezone.js';

const NY = 'America/New_York';

function query(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    timeZone: NY,
    rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 }], // Mondays 09:00-11:00
    overrides: [],
    durationMinutes: 30,
    incrementMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    fromDateKey: '2026-06-15', // a Monday
    days: 1,
    busy: [],
    now: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

test('a two-hour window yields four half-hour slots', () => {
  const slots = generateSlots(query());
  assert.deepEqual(slots.map((s) => s.hostClock), ['09:00', '09:30', '10:00', '10:30']);
  assert.equal(slots[0]!.startsAt.toISOString(), '2026-06-15T13:00:00.000Z');
  assert.equal(slots[3]!.endsAt.toISOString(), '2026-06-15T15:00:00.000Z');
});

test('a slot that would run past the window end is not offered', () => {
  // 09:00-11:00 with 45-minute meetings: 09:00 and 09:45 fit, 10:30 would end
  // at 11:15 and so is not offered.
  const slots = generateSlots(query({ durationMinutes: 45, incrementMinutes: 45 }));
  assert.deepEqual(slots.map((s) => s.hostClock), ['09:00', '09:45']);
  assert.equal(slots.at(-1)!.endsAt.toISOString(), '2026-06-15T14:30:00.000Z');
});

test('rules only fire on their own weekday', () => {
  const slots = generateSlots(query({ fromDateKey: '2026-06-16', days: 1 })); // Tuesday
  assert.equal(slots.length, 0);
});

test('a week of rules spans the whole range', () => {
  const slots = generateSlots(query({ days: 14 }));
  assert.deepEqual([...new Set(slots.map((s) => s.hostDateKey))], ['2026-06-15', '2026-06-22']);
});

test('spring forward: the slots that do not exist are skipped, not shifted', () => {
  // 2026-03-08 is a Sunday; New York jumps 01:59 -> 03:00.
  const slots = generateSlots(
    query({
      rules: [{ weekday: 0, startMinute: 0, endMinute: 5 * 60 }],
      fromDateKey: '2026-03-08',
      now: new Date('2026-03-01T00:00:00Z'),
    }),
  );
  const clocks = slots.map((s) => s.hostClock);
  assert.ok(!clocks.includes('02:00'), '02:00 does not exist that day');
  assert.ok(!clocks.includes('02:30'), '02:30 does not exist that day');
  assert.deepEqual(clocks, ['00:00', '00:30', '01:00', '01:30', '03:00', '03:30', '04:00', '04:30']);

  // Every offered slot must still be a real, strictly increasing instant, and
  // the gap across the jump is one real hour even though the clock skipped one.
  for (let i = 1; i < slots.length; i += 1) {
    assert.ok(slots[i]!.startsAt > slots[i - 1]!.startsAt, 'slots must ascend in UTC');
  }
  const beforeJump = slots.find((s) => s.hostClock === '01:30')!;
  const afterJump = slots.find((s) => s.hostClock === '03:00')!;
  assert.equal(afterJump.startsAt.getTime() - beforeJump.startsAt.getTime(), 30 * 60 * 1000);
});

test('fall back: the repeated hour is offered once, and slots never collide', () => {
  // 2026-11-01, New York repeats 01:00-01:59.
  const slots = generateSlots(
    query({
      rules: [{ weekday: 0, startMinute: 0, endMinute: 4 * 60 }],
      fromDateKey: '2026-11-01',
      now: new Date('2026-10-01T00:00:00Z'),
    }),
  );
  const instants = slots.map((s) => s.startsAt.getTime());
  assert.equal(new Set(instants).size, instants.length, 'no two slots may share an instant');
  assert.deepEqual([...instants].sort((a, b) => a - b), instants);
  assert.equal(slots.filter((s) => s.hostClock === '01:30').length, 1);
  // A 4-hour local window that contains the repeated hour still only offers the
  // wall-clock times once each.
  assert.deepEqual(
    slots.map((s) => s.hostClock),
    ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '03:30'],
  );
});

test('an existing booking removes the overlapping slots', () => {
  const slots = generateSlots(
    query({
      busy: [{ startsAt: new Date('2026-06-15T13:30:00Z'), endsAt: new Date('2026-06-15T14:00:00Z') }],
    }),
  );
  assert.deepEqual(slots.map((s) => s.hostClock), ['09:00', '10:00', '10:30']);
});

test('a buffer clears the slots either side of a booking', () => {
  const slots = generateSlots(
    query({
      bufferMinutes: 15,
      busy: [{ startsAt: new Date('2026-06-15T13:30:00Z'), endsAt: new Date('2026-06-15T14:00:00Z') }],
    }),
  );
  assert.deepEqual(slots.map((s) => s.hostClock), ['10:30']);
});

test('minimum notice hides slots that are too soon', () => {
  const slots = generateSlots(
    query({ now: new Date('2026-06-15T13:00:00Z'), minNoticeMinutes: 60 }),
  );
  assert.deepEqual(slots.map((s) => s.hostClock), ['10:00', '10:30']);
});

test('a blocked date override clears the day', () => {
  const slots = generateSlots(query({ overrides: [{ dateKey: '2026-06-15', blocked: true }] }));
  assert.equal(slots.length, 0);
});

test('a date override replaces the weekly hours for that day', () => {
  const slots = generateSlots(
    query({
      overrides: [{ dateKey: '2026-06-15', blocked: false, startMinute: 14 * 60, endMinute: 15 * 60 }],
    }),
  );
  assert.deepEqual(slots.map((s) => s.hostClock), ['14:00', '14:30']);
});

test('overlapping rules on one day do not produce duplicate slots', () => {
  const slots = generateSlots(
    query({
      rules: [
        { weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 },
        { weekday: 1, startMinute: 9 * 60 + 30, endMinute: 11 * 60 },
      ],
    }),
  );
  assert.deepEqual(slots.map((s) => s.hostClock), ['09:00', '09:30', '10:00', '10:30']);
});

test('slots are grouped by the date the *viewer* sees, not the host', () => {
  // Host in New York offers Monday 09:00-11:00; a viewer in Auckland sees those
  // as Tuesday morning.
  const slots = generateSlots(query());
  const grouped = groupByViewerDate(slots, 'Pacific/Auckland');
  assert.deepEqual([...grouped.keys()], ['2026-06-16']);
  assert.equal(toWallTime(slots[0]!.startsAt, 'Pacific/Auckland').hour, 1);

  const hostGrouped = groupByViewerDate(slots, NY);
  assert.deepEqual([...hostGrouped.keys()], ['2026-06-15']);
});
