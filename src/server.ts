import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { groupByViewerDate } from './availability.js';
import { createSession, destroySession, hashPassword, hostForSession, verifyPassword } from './auth.js';
import { pool } from './db.js';
import { env } from './env.js';
import { AppError, httpStatusFor } from './errors.js';
import { COMMON_TIMEZONES, WEEKDAY_NAMES, formatDate, formatDateShort, formatRange, formatTime } from './format.js';
import { buildIcs } from './ics.js';
import { migrate } from './migrate.js';
import { sendBookingConfirmation, sendCancellation } from './notify.js';
import {
  availableSlots,
  cancelBooking,
  createBooking,
  createEventType,
  createHost,
  deleteEventType,
  deleteOverride,
  getBookingByToken,
  getDemoHost,
  getEventType,
  getHostByEmail,
  getHostById,
  getHostBySlug,
  listBookings,
  listEventTypes,
  listOverrides,
  listRules,
  replaceRules,
  slugify,
  updateHostTimeZone,
  upsertOverride,
  type EventType,
  type Host,
} from './scheduling.js';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemoHost } from './seed.js';
import { addDaysToDateKey, isValidTimeZone, parseClock, parseDateKey, toDateKey, zoneAbbreviation } from './timezone.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_COOKIE = 'slotline_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      host_?: Host;
    }
  }
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * Timezone the visitor is in. The form posts it as a hidden field because a
 * booking POST has no query string, and relying on a cookie would quietly file
 * the booking under the host's zone for anyone who blocks them.
 */
function viewerTimeZone(req: express.Request, fallback: string): string {
  const candidates = [req.body?.timeZone, req.query.tz, req.cookies?.slotline_tz];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isValidTimeZone(candidate)) return candidate;
  }
  return fallback;
}

export function createApp(): express.Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.locals.formatTime = formatTime;
  app.locals.formatDate = formatDate;
  app.locals.formatDateShort = formatDateShort;
  app.locals.formatRange = formatRange;
  app.locals.zoneAbbreviation = zoneAbbreviation;
  app.locals.WEEKDAY_NAMES = WEEKDAY_NAMES;
  app.locals.COMMON_TIMEZONES = COMMON_TIMEZONES;

  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(rootDir, 'public'), { maxAge: '1h' }));

  app.use((req, res, next) => {
    hostForSession(req.cookies?.[SESSION_COOKIE])
      .then(async (hostId) => {
        req.host_ = hostId ? await getHostById(hostId) : undefined;
        res.locals.currentHost = req.host_;
        next();
      })
      .catch(next);
  });

  app.get('/healthz', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  /* ------------------------------------------------------------- marketing */

  app.get('/', asyncRoute(async (_req, res) => {
    const demo = await getDemoHost();
    res.render('index', { demoHost: demo ?? null, demoEmail: DEMO_EMAIL, demoPassword: DEMO_PASSWORD });
  }));

  /** One click from the landing page into a populated account. */
  app.post('/demo-login', asyncRoute(async (_req, res) => {
    const demo = (await getDemoHost()) ?? (await seedDemoHost());
    const token = await createSession(demo.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.redirect('/app');
  }));

  /* ------------------------------------------------------------------ auth */

  app.get('/login', (req, res) => {
    if (req.host_) return res.redirect('/app');
    res.render('login', { error: null, email: '' });
  });

  app.post('/login', asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '');
    const found = await getHostByEmail(email);
    if (!found || !(await verifyPassword(String(req.body?.password ?? ''), found.passwordHash))) {
      res.status(401).render('login', { error: 'That email and password do not match.', email });
      return;
    }
    const token = await createSession(found.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.redirect('/app');
  }));

  app.get('/signup', (req, res) => {
    if (req.host_) return res.redirect('/app');
    res.render('signup', { error: null, values: { name: '', email: '', slug: '', timeZone: 'UTC' } });
  });

  app.post('/signup', asyncRoute(async (req, res) => {
    const values = {
      name: String(req.body?.name ?? '').trim(),
      email: String(req.body?.email ?? '').trim(),
      slug: slugify(String(req.body?.slug ?? '') || String(req.body?.name ?? '')),
      timeZone: String(req.body?.timeZone ?? 'UTC'),
    };
    const password = String(req.body?.password ?? '');
    const fail = (error: string) => res.status(400).render('signup', { error, values });

    if (!values.name) return fail('Please give your name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) return fail('That email address does not look right.');
    if (password.length < 8) return fail('Use a password of at least 8 characters.');
    if (!values.slug) return fail('Pick a link name — letters and numbers.');
    if (!isValidTimeZone(values.timeZone)) return fail('Pick a timezone from the list.');

    try {
      const created = await createHost({
        email: values.email,
        passwordHash: await hashPassword(password),
        name: values.name,
        slug: values.slug,
        timeZone: values.timeZone,
      });
      // Sensible defaults beat an empty availability page.
      await replaceRules(
        created.id,
        [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
      );
      await createEventType({ hostId: created.id, title: '30 minute meeting', durationMinutes: 30 });
      const token = await createSession(created.id);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
      res.redirect('/app/availability');
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return fail('That email or link name is already taken.');
      }
      throw error;
    }
  }));

  app.post('/logout', asyncRoute(async (req, res) => {
    await destroySession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    res.redirect('/');
  }));

  /* ------------------------------------------------------------ host pages */

  const requireHost: express.RequestHandler = (req, res, next) => {
    if (!req.host_) return res.redirect('/login');
    next();
  };

  app.get('/app', requireHost, asyncRoute(async (req, res) => {
    const host = req.host_!;
    const past = req.query.view === 'past';
    const [bookings, eventTypes] = await Promise.all([
      listBookings(host.id, { upcoming: !past }),
      listEventTypes(host.id),
    ]);
    res.render('bookings', { host, bookings, eventTypes, past, baseUrl: env.baseUrl });
  }));

  app.get('/app/availability', requireHost, asyncRoute(async (req, res) => {
    const host = req.host_!;
    const [rules, overrides, eventTypes] = await Promise.all([
      listRules(host.id),
      listOverrides(host.id),
      listEventTypes(host.id),
    ]);
    res.render('availability', {
      host,
      rules,
      overrides,
      eventTypes,
      saved: req.query.saved === '1',
      baseUrl: env.baseUrl,
    });
  }));

  app.post('/app/availability', requireHost, asyncRoute(async (req, res) => {
    const host = req.host_!;
    const timeZone = String(req.body?.timeZone ?? host.timeZone);
    await updateHostTimeZone(host.id, timeZone);

    const rules = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (!req.body?.[`enabled_${weekday}`]) continue;
      const start = parseClock(String(req.body?.[`start_${weekday}`] ?? ''));
      const end = parseClock(String(req.body?.[`end_${weekday}`] ?? ''));
      if (start === null || end === null || start >= end) continue;
      rules.push({ weekday, startMinute: start, endMinute: end });
    }
    await replaceRules(host.id, rules);
    res.redirect('/app/availability?saved=1');
  }));

  app.post('/app/event-types', requireHost, asyncRoute(async (req, res) => {
    const host = req.host_!;
    await createEventType({
      hostId: host.id,
      title: String(req.body?.title ?? ''),
      description: String(req.body?.description ?? ''),
      durationMinutes: Math.max(5, Math.min(480, Number(req.body?.durationMinutes) || 30)),
      incrementMinutes: Math.max(5, Math.min(480, Number(req.body?.incrementMinutes) || 30)),
      bufferMinutes: Math.max(0, Math.min(240, Number(req.body?.bufferMinutes) || 0)),
      minNoticeMinutes: Math.max(0, Number(req.body?.minNoticeMinutes) || 0),
    });
    res.redirect('/app/availability?saved=1');
  }));

  app.post('/app/event-types/:id/delete', requireHost, asyncRoute(async (req, res) => {
    await deleteEventType(req.host_!.id, String(req.params.id));
    res.redirect('/app/availability?saved=1');
  }));

  app.post('/app/overrides', requireHost, asyncRoute(async (req, res) => {
    const host = req.host_!;
    const dateKey = String(req.body?.dateKey ?? '');
    if (!parseDateKey(dateKey)) throw new AppError('INVALID', 'Pick a valid date.');
    if (req.body?.mode === 'hours') {
      const start = parseClock(String(req.body?.start ?? ''));
      const end = parseClock(String(req.body?.end ?? ''));
      if (start === null || end === null || start >= end) throw new AppError('INVALID', 'Those hours do not make sense.');
      await upsertOverride(host.id, { dateKey, blocked: false, startMinute: start, endMinute: end });
    } else {
      await upsertOverride(host.id, { dateKey, blocked: true });
    }
    res.redirect('/app/availability?saved=1');
  }));

  app.post('/app/overrides/:dateKey/delete', requireHost, asyncRoute(async (req, res) => {
    await deleteOverride(req.host_!.id, String(req.params.dateKey));
    res.redirect('/app/availability?saved=1');
  }));

  /* --------------------------------------------------------------- booking */

  app.get('/booking/:token', asyncRoute(async (req, res) => {
    const booking = await getBookingByToken(String(req.params.token));
    if (!booking) {
      res.status(404).render('not-found', { message: 'We could not find that booking.' });
      return;
    }
    const host = (await getHostById(booking.hostId))!;
    const eventTypes = await listEventTypes(host.id);
    const eventType = eventTypes.find((type) => type.id === booking.eventTypeId);
    res.render('booking-detail', {
      booking,
      host,
      eventType,
      viewerTimeZone: viewerTimeZone(req, booking.inviteeTimeZone),
      cancelled: booking.status === 'cancelled',
    });
  }));

  app.get('/booking/:token/calendar.ics', asyncRoute(async (req, res) => {
    const booking = await getBookingByToken(String(req.params.token));
    if (!booking) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const host = (await getHostById(booking.hostId))!;
    const eventType = (await listEventTypes(host.id)).find((type) => type.id === booking.eventTypeId);
    const cancelled = booking.status === 'cancelled';
    res
      .type('text/calendar; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="invite.ics"')
      .send(
        buildIcs({
          uid: `${booking.id}@slotline`,
          sequence: booking.sequence,
          method: cancelled ? 'CANCEL' : 'REQUEST',
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          summary: `${eventType?.title ?? 'Meeting'} — ${host.name} & ${booking.inviteeName}`,
          description: eventType?.description ?? '',
          url: `${env.baseUrl}/booking/${booking.cancelToken}`,
          organizer: { name: host.name, email: host.email },
          attendee: { name: booking.inviteeName, email: booking.inviteeEmail },
        }),
      );
  }));

  app.post('/booking/:token/cancel', asyncRoute(async (req, res) => {
    const existing = await getBookingByToken(String(req.params.token));
    if (!existing) {
      res.status(404).render('not-found', { message: 'We could not find that booking.' });
      return;
    }
    const booking = await cancelBooking(String(req.params.token));
    const host = (await getHostById(booking.hostId))!;
    const eventType = (await listEventTypes(host.id)).find((type) => type.id === booking.eventTypeId);
    if (eventType) {
      await sendCancellation({ booking, host, eventType, cancelledBy: req.host_ ? 'host' : 'invitee' });
    }
    res.redirect(`/booking/${booking.cancelToken}`);
  }));

  /* --------------------------------------------------------- public pages */

  app.get('/:hostSlug', asyncRoute(async (req, res) => {
    const host = await getHostBySlug(String(req.params.hostSlug));
    if (!host) {
      res.status(404).render('not-found', { message: 'No one by that name here.' });
      return;
    }
    const eventTypes = (await listEventTypes(host.id)).filter((type) => type.isActive);
    res.render('host', { host, eventTypes });
  }));

  app.get('/:hostSlug/:eventSlug', asyncRoute(async (req, res) => {
    const host = await getHostBySlug(String(req.params.hostSlug));
    const eventType = host ? await getEventType(host.id, String(req.params.eventSlug)) : undefined;
    if (!host || !eventType) {
      res.status(404).render('not-found', { message: 'That booking page does not exist.' });
      return;
    }
    await renderBookingPage(req, res, host, eventType, { error: null, values: {} });
  }));

  app.post('/:hostSlug/:eventSlug', asyncRoute(async (req, res) => {
    const host = await getHostBySlug(String(req.params.hostSlug));
    const eventType = host ? await getEventType(host.id, String(req.params.eventSlug)) : undefined;
    if (!host || !eventType) {
      res.status(404).render('not-found', { message: 'That booking page does not exist.' });
      return;
    }

    const startsAtRaw = String(req.body?.startsAt ?? '');
    const startsAt = new Date(startsAtRaw);
    const values = {
      inviteeName: String(req.body?.inviteeName ?? ''),
      inviteeEmail: String(req.body?.inviteeEmail ?? ''),
      notes: String(req.body?.notes ?? ''),
      startsAt: startsAtRaw,
    };
    const timeZone = viewerTimeZone(req, host.timeZone);

    if (Number.isNaN(startsAt.getTime())) {
      await renderBookingPage(req, res, host, eventType, { error: 'Pick a time first.', values }, 400);
      return;
    }

    try {
      const booking = await createBooking({
        host,
        eventType,
        startsAt,
        inviteeName: values.inviteeName,
        inviteeEmail: values.inviteeEmail,
        inviteeTimeZone: timeZone,
        notes: values.notes,
      });
      await sendBookingConfirmation({ booking, host, eventType });
      res.redirect(`/booking/${booking.cancelToken}?booked=1`);
    } catch (error) {
      if (error instanceof AppError) {
        // A lost race re-renders the page with fresh slots, so the visitor can
        // pick again without losing what they typed.
        await renderBookingPage(
          req,
          res,
          host,
          eventType,
          { error: error.message, values },
          httpStatusFor[error.code],
        );
        return;
      }
      throw error;
    }
  }));

  async function renderBookingPage(
    req: express.Request,
    res: express.Response,
    host: Host,
    eventType: EventType,
    extras: { error: string | null; values: Record<string, string> },
    status = 200,
  ): Promise<void> {
    const type = eventType;
    const timeZone = viewerTimeZone(req, host.timeZone);
    const now = new Date();
    const requestedFrom = typeof req.query.from === 'string' && parseDateKey(req.query.from) ? req.query.from : null;
    const fromDateKey = requestedFrom ?? toDateKey(now, host.timeZone);
    const days = 14;

    const slots = await availableSlots({ host, eventType: type, fromDateKey, days, now });
    const grouped = groupByViewerDate(slots, timeZone);

    res.status(status).render('book', {
      host,
      eventType: type,
      timeZone,
      grouped: [...grouped.entries()],
      fromDateKey,
      prevFrom: addDaysToDateKey(fromDateKey, -days),
      nextFrom: addDaysToDateKey(fromDateKey, days),
      todayKey: toDateKey(now, host.timeZone),
      error: extras.error,
      values: extras.values,
    });
  }

  app.use((_req, res) => res.status(404).render('not-found', { message: 'That page does not exist.' }));

  app.use(((error, _req, res, _next) => {
    if (error instanceof AppError) {
      res.status(httpStatusFor[error.code]).render('not-found', { message: error.message });
      return;
    }
    console.error(error);
    res.status(500).render('not-found', { message: 'Something went wrong on our side.' });
  }) as express.ErrorRequestHandler);

  return app;
}

export async function start(): Promise<void> {
  const applied = await migrate();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  if (env.seedDemo) await seedDemoHost();

  const server = createServer(createApp());
  server.listen(env.port, () => console.log(`slotline listening on http://localhost:${env.port}`));

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
