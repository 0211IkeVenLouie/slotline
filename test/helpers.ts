import { pool, query } from '../src/db.js';
import { migrate } from '../src/migrate.js';

let migrated = false;

export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  await query('TRUNCATE hosts, event_types, availability_rules, date_overrides, bookings, sessions CASCADE');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
