export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/slotline',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  seedDemo: process.env.SEED_DEMO !== 'false',
  /** Public origin, used in emails and .ics links. */
  baseUrl: (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'Slotline <bookings@example.com>',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-insecure-secret',
};
