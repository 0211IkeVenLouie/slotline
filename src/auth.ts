import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.js';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  // Constant time, and length-safe: timingSafeEqual throws on a length mismatch.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export async function createSession(hostId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token, host_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, hostId, String(SESSION_DAYS)],
  );
  return token;
}

export async function hostForSession(token: string | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  const row = await one<{ host_id: string }>(
    'SELECT host_id FROM sessions WHERE token = $1 AND expires_at > now()',
    [token],
  );
  return row?.host_id;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export function newCancelToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}
