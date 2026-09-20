-- btree_gist lets a GiST exclusion constraint mix an equality column (host_id)
-- with a range column. It ships with the standard Postgres contrib package and
-- is available on Fly.io, Railway, Supabase and RDS.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  slug          text UNIQUE NOT NULL,
  -- The zone the availability rules are written in. Everything stored is UTC;
  -- this is what turns "Tuesdays 09:00" into an instant.
  time_zone     text NOT NULL DEFAULT 'UTC',
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id            uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  slug               text NOT NULL,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  duration_minutes   integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  increment_minutes  integer NOT NULL DEFAULT 30 CHECK (increment_minutes BETWEEN 5 AND 480),
  buffer_minutes     integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  min_notice_minutes integer NOT NULL DEFAULT 60 CHECK (min_notice_minutes >= 0),
  advance_days       integer NOT NULL DEFAULT 30 CHECK (advance_days BETWEEN 1 AND 365),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, slug)
);

CREATE TABLE IF NOT EXISTS availability_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  weekday      integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- Minutes since midnight in the host's timezone, NOT in UTC: the whole point
  -- is that "09:00 on a Tuesday" keeps meaning 09:00 after the clocks change.
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (start_minute < end_minute)
);
CREATE INDEX IF NOT EXISTS availability_rules_host_idx ON availability_rules (host_id, weekday);

CREATE TABLE IF NOT EXISTS date_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  date_key     date NOT NULL,
  blocked      boolean NOT NULL DEFAULT true,
  start_minute integer CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   integer CHECK (end_minute BETWEEN 1 AND 1440),
  UNIQUE (host_id, date_key),
  CHECK (blocked OR (start_minute IS NOT NULL AND end_minute IS NOT NULL AND start_minute < end_minute))
);

CREATE TABLE IF NOT EXISTS bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  event_type_id     uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  invitee_name      text NOT NULL,
  invitee_email     text NOT NULL,
  invitee_time_zone text NOT NULL,
  notes             text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  cancel_token      text UNIQUE NOT NULL,
  sequence          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  CHECK (ends_at > starts_at),

  -- The double-booking answer.
  --
  -- Checking "is this slot free?" and then inserting is a read-then-write race:
  -- two requests a few milliseconds apart both read free and both insert. This
  -- constraint makes the overlap impossible at the storage layer, so the second
  -- insert fails with SQLSTATE 23P01 no matter how close together they arrive,
  -- across any number of application processes. Cancelled bookings are excluded
  -- so a cancelled slot becomes bookable again.
  EXCLUDE USING gist (
    host_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'confirmed')
);
CREATE INDEX IF NOT EXISTS bookings_host_start_idx ON bookings (host_id, starts_at);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  host_id    uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
