import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIcs, escapeText, foldLine, formatIcsDate } from '../src/ics.js';

const base = {
  uid: 'booking-123@slotline',
  sequence: 0,
  method: 'REQUEST' as const,
  startsAt: new Date('2026-06-15T13:00:00Z'),
  endsAt: new Date('2026-06-15T13:30:00Z'),
  summary: 'Intro call: Ada Lovelace & Priya Raman',
  description: 'A 30 minute chat.',
  organizer: { name: 'Priya Raman', email: 'priya@example.com' },
  attendee: { name: 'Ada Lovelace', email: 'ada@example.com' },
  timestamp: new Date('2026-06-01T09:00:00Z'),
};

test('dates are UTC basic-format', () => {
  assert.equal(formatIcsDate(new Date('2026-06-15T13:00:00Z')), '20260615T130000Z');
});

test('structural characters are escaped', () => {
  assert.equal(escapeText('Call with Ada, Grace; and others'), 'Call with Ada\\, Grace\; and others');
  assert.equal(escapeText('line one\nline two'), 'line one\\nline two');
  assert.equal(escapeText('back\\slash'), 'back\\\\slash');
});

test('long lines fold at 75 octets with a leading space', () => {
  const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, 'should have folded');
  assert.ok(Buffer.from(lines[0]!, 'utf8').length <= 75);
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith(' '), 'continuation lines start with a space');
    assert.ok(Buffer.from(line, 'utf8').length <= 75);
  }
  assert.equal(folded.split('\r\n ').join(''), `DESCRIPTION:${'x'.repeat(200)}`);
});

test('folding never splits a multi-byte character', () => {
  const folded = foldLine(`SUMMARY:${'日'.repeat(60)}`);
  for (const line of folded.split('\r\n')) {
    // A split character would decode to U+FFFD.
    assert.ok(!line.includes('�'), 'fold split a character');
  }
  assert.equal(folded.split('\r\n ').join(''), `SUMMARY:${'日'.repeat(60)}`);
});

test('an invitation carries the event, the people and a stable uid', () => {
  const ics = buildIcs(base);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.includes('METHOD:REQUEST\r\n'));
  assert.ok(ics.includes('UID:booking-123@slotline\r\n'));
  assert.ok(ics.includes('DTSTART:20260615T130000Z\r\n'));
  assert.ok(ics.includes('DTEND:20260615T133000Z\r\n'));
  assert.ok(ics.includes('DTSTAMP:20260601T090000Z\r\n'));
  assert.ok(ics.includes('STATUS:CONFIRMED\r\n'));
  assert.ok(ics.includes('ORGANIZER;CN=Priya Raman:mailto:priya@example.com\r\n'));
  assert.ok(ics.includes('mailto:ada@example.com'));
  // The summary contains an ampersand and a colon; only iCalendar's own
  // specials need escaping, so they survive as-is.
  assert.ok(ics.includes('SUMMARY:Intro call: Ada Lovelace & Priya Raman\r\n'));
});

test('every line ends with CRLF and none exceeds 75 octets', () => {
  const ics = buildIcs({ ...base, description: 'A much longer description. '.repeat(12) });
  assert.ok(!/(?<!\r)\n/.test(ics), 'found a bare LF');
  for (const line of ics.split('\r\n').filter(Boolean)) {
    assert.ok(Buffer.from(line, 'utf8').length <= 75, `line too long: ${line.slice(0, 40)}…`);
  }
});

test('a cancellation bumps the sequence and cancels the event', () => {
  const ics = buildIcs({ ...base, method: 'CANCEL', sequence: 1 });
  assert.ok(ics.includes('METHOD:CANCEL\r\n'));
  assert.ok(ics.includes('STATUS:CANCELLED\r\n'));
  assert.ok(ics.includes('SEQUENCE:1\r\n'));
  // Same UID as the invitation, which is what makes a calendar client remove
  // the original event rather than add a second one.
  assert.ok(ics.includes('UID:booking-123@slotline\r\n'));
});
