/**
 * Access control.
 *
 * This app holds a record of where its owner has been, so it is locked by
 * default when it is reachable from anywhere but the machine it runs on. A
 * passcode is hashed with scrypt; the session is a signed cookie. There are no
 * accounts and no third parties involved.
 *
 * Share links are separate and deliberately narrow: they grant read-only access
 * to the exports for an accountant, nothing else, and can be revoked.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import type { Database } from '../db/index.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';

const SESSION_COOKIE = 'ml_session';
const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const PASSCODE_KEY = 'passcode_hash';
const SECRET_KEY = 'app_secret';

export function appSecret(db: Database): string {
  if (config.secret !== '') return config.secret;
  const existing = db.setting(SECRET_KEY);
  if (existing !== undefined) return existing;
  const generated = randomBytes(32).toString('hex');
  db.putSetting(SECRET_KEY, generated);
  return generated;
}

function hashPasscode(passcode: string, salt: string): string {
  return scryptSync(passcode.normalize('NFKC'), salt, 32).toString('hex');
}

export function setPasscode(db: Database, passcode: string): void {
  if (passcode.trim() === '') {
    db.run('DELETE FROM setting WHERE key = ?', PASSCODE_KEY);
    db.audit('owner', 'auth.passcode.clear');
    return;
  }
  const salt = randomBytes(16).toString('hex');
  db.putSetting(PASSCODE_KEY, `scrypt:${salt}:${hashPasscode(passcode, salt)}`);
  db.audit('owner', 'auth.passcode.set');
}

export function hasPasscode(db: Database): boolean {
  return config.passcode !== '' || db.setting(PASSCODE_KEY) !== undefined;
}

export function checkPasscode(db: Database, attempt: string): boolean {
  if (config.passcode !== '') {
    const a = Buffer.from(attempt.normalize('NFKC'));
    const b = Buffer.from(config.passcode.normalize('NFKC'));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const stored = db.setting(PASSCODE_KEY);
  if (stored === undefined) return true;
  const [scheme, salt, digest] = stored.split(':');
  if (scheme !== 'scrypt' || salt === undefined || digest === undefined) return false;
  const candidate = Buffer.from(hashPasscode(attempt, salt), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSession(db: Database): string {
  const payload = `${Date.now() + SESSION_TTL_SECONDS * 1000}`;
  return `${payload}.${sign(appSecret(db), payload)}`;
}

export function sessionValid(db: Database, cookie: string | undefined): boolean {
  if (cookie === undefined) return false;
  const [payload, signature] = cookie.split('.');
  if (payload === undefined || signature === undefined) return false;
  const expected = sign(appSecret(db), payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expiry = Number(payload);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

export const sessionCookieName = SESSION_COOKIE;
export const sessionTtlSeconds = SESSION_TTL_SECONDS;

/**
 * Whether an unauthenticated request may proceed. Only true when the app is
 * bound to loopback and no passcode has been set — the "just running it on my
 * own laptop" case, where a login screen would be friction with no benefit.
 */
export function openAccessAllowed(db: Database): boolean {
  if (hasPasscode(db)) return false;
  const local = config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1';
  if (!local) {
    log.warn(
      'no passcode is set and the app is listening on a non-loopback address; access is locked until a passcode is set',
    );
  }
  return local;
}

export function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}
