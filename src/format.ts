import { zoneAbbreviation } from './timezone.js';

export function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

export function formatDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}

export function formatDateShort(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(instant);
}

/** "Monday 15 June 2026, 09:00–09:30 (GMT-4)" — the one line that has to be unambiguous. */
export function formatRange(startsAt: Date, endsAt: Date, timeZone: string): string {
  return `${formatDate(startsAt, timeZone)}, ${formatTime(startsAt, timeZone)}–${formatTime(
    endsAt,
    timeZone,
  )} (${zoneAbbreviation(startsAt, timeZone)})`;
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A short, curated list; the rest are reachable because the field accepts any IANA name. */
export const COMMON_TIMEZONES = [
  'Pacific/Auckland',
  'Australia/Sydney',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/London',
  'UTC',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];
