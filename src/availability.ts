import {
  addDaysToDateKey,
  formatClock,
  parseDateKey,
  wallTimeToInstant,
  weekdayOf,
} from './timezone.js';

export interface AvailabilityRule {
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes since midnight, in the host's timezone. */
  startMinute: number;
  endMinute: number;
}

export interface DateOverride {
  dateKey: string;
  blocked: boolean;
  startMinute?: number | null;
  endMinute?: number | null;
}

export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

export interface Slot extends Interval {
  /** The date the slot falls on *in the host's* timezone, for grouping. */
  hostDateKey: string;
  /** The host's local start time, handy for debugging a DST report. */
  hostClock: string;
}

export interface SlotQuery {
  /** IANA zone the availability rules are written in. */
  timeZone: string;
  rules: AvailabilityRule[];
  overrides: DateOverride[];
  durationMinutes: number;
  /** Slots start every N minutes; usually the duration, sometimes 15. */
  incrementMinutes: number;
  /** Dead time kept either side of an existing booking. */
  bufferMinutes: number;
  /** How soon from now a booking may start. */
  minNoticeMinutes: number;
  fromDateKey: string;
  days: number;
  busy: Interval[];
  now: Date;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/**
 * Expand weekly availability into concrete UTC instants.
 *
 * Rules are written in the host's wall-clock time ("Tuesdays, 09:00-17:00"),
 * which means a rule is not a fixed duration in UTC: on the day the clocks
 * change, "09:00" moves by an hour and one local hour may not exist at all.
 * So every candidate start is converted through the host's zone individually,
 * and any wall time the zone skips is dropped rather than shifted.
 */
export function generateSlots(query: SlotQuery): Slot[] {
  const {
    timeZone,
    rules,
    overrides,
    durationMinutes,
    incrementMinutes,
    bufferMinutes,
    minNoticeMinutes,
    fromDateKey,
    days,
    busy,
    now,
  } = query;

  if (durationMinutes <= 0 || incrementMinutes <= 0) return [];
  if (!parseDateKey(fromDateKey)) throw new Error(`Invalid from date: ${fromDateKey}`);

  const overrideByDate = new Map(overrides.map((entry) => [entry.dateKey, entry]));
  const earliest = new Date(now.getTime() + minNoticeMinutes * 60000);
  // Blocking time around a booking is done by fattening the booking, so the
  // overlap test stays a plain interval comparison.
  const blocked = busy.map((interval) => ({
    startsAt: new Date(interval.startsAt.getTime() - bufferMinutes * 60000),
    endsAt: new Date(interval.endsAt.getTime() + bufferMinutes * 60000),
  }));

  const slots: Slot[] = [];

  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    const dateKey = addDaysToDateKey(fromDateKey, dayIndex);
    const parsed = parseDateKey(dateKey)!;
    const override = overrideByDate.get(dateKey);

    if (override?.blocked) continue;

    const windows: Array<{ startMinute: number; endMinute: number }> =
      override && override.startMinute != null && override.endMinute != null
        ? [{ startMinute: override.startMinute, endMinute: override.endMinute }]
        : rules
            .filter((rule) => rule.weekday === weekdayOf(dateKey))
            .map((rule) => ({ startMinute: rule.startMinute, endMinute: rule.endMinute }));

    for (const window of windows) {
      for (
        let minute = window.startMinute;
        minute + durationMinutes <= window.endMinute;
        minute += incrementMinutes
      ) {
        const startsAt = wallTimeToInstant(
          {
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
            hour: Math.floor(minute / 60),
            minute: minute % 60,
          },
          timeZone,
        );
        // The clocks skipped this wall time; there is no such moment to book.
        if (startsAt === null) continue;

        const endsAt = new Date(startsAt.getTime() + durationMinutes * 60000);
        if (startsAt < earliest) continue;
        if (blocked.some((interval) => overlaps({ startsAt, endsAt }, interval))) continue;

        slots.push({ startsAt, endsAt, hostDateKey: dateKey, hostClock: formatClock(minute) });
      }
    }
  }

  // Two rules on the same day, or a DST fall-back, can produce out-of-order or
  // duplicated instants; the caller wants a clean ascending list.
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots.filter(
    (slot, index) => index === 0 || slot.startsAt.getTime() !== slots[index - 1]!.startsAt.getTime(),
  );
}

/** Group slots by the date they fall on *in the viewer's* zone, for rendering. */
export function groupByViewerDate(slots: Slot[], viewerTimeZone: string): Map<string, Slot[]> {
  const grouped = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: viewerTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(slot.startsAt);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(slot);
    else grouped.set(key, [slot]);
  }
  return grouped;
}
