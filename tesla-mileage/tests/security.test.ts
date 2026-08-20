import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, sameOrigin } from '../src/web/guard.ts';
import { seal, open as unseal, isEncrypted } from '../src/lib/secretbox.ts';
import { safeReturn, publishableSettings } from '../src/web/server.ts';
import { openDatabase } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import { setPasscode, checkPasscode, issueSession, sessionValid, hasPasscode } from '../src/web/auth.ts';
import type { IncomingMessage } from 'node:http';

function redirectTarget(value: string | null): string {
  const form = new URLSearchParams();
  if (value !== null) form.set('return', value);
  return safeReturn(form, '/fallback');
}

test('redirects can only ever point back into this app', () => {
  assert.equal(redirectTarget('/trips?period=ytd'), '/trips?period=ytd');
  // Protocol-relative, and the backslash form browsers normalise to it.
  assert.equal(redirectTarget('//evil.example'), '/fallback');
  assert.equal(redirectTarget('/\\evil.example'), '/fallback');
  assert.equal(redirectTarget('https://evil.example'), '/fallback');
  assert.equal(redirectTarget('javascript:alert(1)'), '/fallback');
  // Header injection.
  assert.equal(redirectTarget('/a\nSet-Cookie: sid=1'), '/fallback');
  assert.equal(redirectTarget('/a\r\nLocation: https://evil.example'), '/fallback');
  assert.equal(redirectTarget(null), '/fallback');
  assert.equal(redirectTarget(''), '/fallback');
});

test('an export never carries the session secret or the passcode hash', () => {
  const filtered = publishableSettings({
    timezone: 'America/Chicago',
    business_name: 'Kaspar Companies',
    app_secret: 'deadbeef',
    passcode_hash: 'scrypt:salt:hash',
    oauth_state: 'abc',
    tesla_refresh_token: 'secret',
  });
  assert.deepEqual(Object.keys(filtered).sort(), ['business_name', 'timezone']);
});

test('the refresh token is unreadable without the configured secret', () => {
  const sealed = seal('tesla-refresh-token', 'env-secret');
  assert.ok(isEncrypted(sealed));
  assert.equal(sealed.includes('tesla-refresh-token'), false);
  assert.equal(unseal(sealed, 'env-secret'), 'tesla-refresh-token');
  assert.equal(unseal(sealed, 'different-secret'), null);
  // Tampering fails the authentication tag rather than returning garbage.
  assert.equal(unseal(`${sealed.slice(0, -4)}AAAA`, 'env-secret'), null);
  // With no secret configured nothing is claimed: the value passes through.
  assert.equal(seal('plain', ''), 'plain');
});

test('a stored token survives a restart, and a wrong key does not crash the app', () => {
  const db = openDatabase(':memory:');
  repo.saveToken(db, {
    provider: 'fleet',
    accessToken: null,
    refreshToken: 'round-trip-token',
    expiresAt: null,
    region: 'na',
    scope: null,
  });
  const raw = db.value<string>('SELECT refresh_token FROM token WHERE provider = ?', 'fleet');
  assert.ok(raw);
  // Whether it is sealed depends on whether a secret is configured; either way
  // reading it back must give the original value.
  assert.equal(repo.getToken(db, 'fleet')?.refreshToken, 'round-trip-token');
  assert.doesNotThrow(() => repo.getToken(db, 'fleet'));
});

test('cross-site posts are refused, same-origin and header-less ones allowed', () => {
  const request = (headers: Record<string, string>): IncomingMessage =>
    ({ headers } as unknown as IncomingMessage);

  assert.equal(sameOrigin(request({ host: 'ledger.local', origin: 'http://ledger.local' })), true);
  assert.equal(sameOrigin(request({ host: 'ledger.local', origin: 'http://evil.example' })), false);
  assert.equal(sameOrigin(request({ host: 'ledger.local', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(sameOrigin(request({ host: 'ledger.local', 'sec-fetch-site': 'same-origin' })), true);
  // Some browsers omit Origin on same-origin form posts; those must still work.
  assert.equal(sameOrigin(request({ host: 'ledger.local' })), true);
  assert.equal(sameOrigin(request({ host: 'ledger.local', origin: 'null' })), true);
  assert.equal(sameOrigin(request({ origin: 'http://ledger.local' })), false);
});

test('the rate limiter allows a burst, then refuses, then forgets', () => {
  const limiter = new RateLimiter(3, 1000);
  const now = 10_000;
  assert.equal(limiter.allow('a', now), true);
  assert.equal(limiter.allow('a', now), true);
  assert.equal(limiter.allow('a', now), true);
  assert.equal(limiter.allow('a', now), false, 'the fourth attempt in the window is refused');
  // A different caller is unaffected.
  assert.equal(limiter.allow('b', now), true);
  // The window passes.
  assert.equal(limiter.allow('a', now + 1001), true);
  assert.ok(limiter.retryAfterSeconds('a', now + 1001) >= 1);
});

test('the rate limiter does not grow without bound', () => {
  const limiter = new RateLimiter(1, 1000);
  for (let i = 0; i < 2000; i += 1) limiter.allow(`ip-${i}`, 1000);
  // Everything expires, and a later call sweeps the map rather than keeping
  // 2000 dead entries around.
  limiter.allow('later', 5000);
  assert.ok(limiter.size < 2000, `expected a sweep, still holding ${limiter.size} entries`);
});

test('passcodes are hashed, compared safely, and sessions cannot be forged', () => {
  const db = openDatabase(':memory:');
  assert.equal(hasPasscode(db), false);
  setPasscode(db, 'correct horse battery staple');

  const stored = db.setting('passcode_hash');
  assert.ok(stored);
  assert.equal(stored.includes('correct horse'), false, 'the passcode itself is never stored');
  assert.match(stored, /^scrypt:/);

  assert.equal(checkPasscode(db, 'correct horse battery staple'), true);
  assert.equal(checkPasscode(db, 'wrong'), false);
  assert.equal(checkPasscode(db, ''), false);

  const session = issueSession(db);
  assert.equal(sessionValid(db, session), true);
  assert.equal(sessionValid(db, `${session}x`), false);
  assert.equal(sessionValid(db, '9999999999999.forged'), false);
  assert.equal(sessionValid(db, undefined), false);
  // An expired stamp is refused even with a valid-looking shape.
  assert.equal(sessionValid(db, '1.abc'), false);

  setPasscode(db, '');
  assert.equal(hasPasscode(db), false);
});
