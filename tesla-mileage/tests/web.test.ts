import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

// The app reads its configuration once, at import time.
const workdir = mkdtempSync(join(tmpdir(), 'mile-ledger-test-'));
process.env.MILE_LEDGER_DB = join(workdir, 'test.db');
process.env.MILE_LEDGER_CONNECTOR = 'manual';
process.env.MILE_LEDGER_HOST = '127.0.0.1';
process.env.MILE_LEDGER_GEOCODE = '0';
process.env.MILE_LEDGER_TZ = 'America/Chicago';
process.env.MILE_LEDGER_LOG = 'error';

const { createApp } = await import('../src/app.ts');
const { createHttpServer } = await import('../src/web/server.ts');
const repo = await import('../src/db/repo.ts');

const app = createApp();
let server: Server;
let base = '';

before(async () => {
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  app.poller.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.db.close();
  rmSync(workdir, { recursive: true, force: true });
});

/** A cookie jar, so the tests can hold a real session like a browser does. */
const jar = new Map<string, string>();

function cookieHeader(): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function remember(response: Response): Response {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const index = pair === undefined ? -1 : pair.indexOf('=');
    if (pair === undefined || index < 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '' || /Max-Age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}

async function get(path: string): Promise<Response> {
  return remember(
    await fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: cookieHeader() } }),
  );
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return remember(
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
      body: new URLSearchParams(body),
      redirect: 'manual',
    }),
  );
}

test('every screen renders', async () => {
  for (const path of ['/', '/trips', '/places', '/places/new', '/rules', '/export', '/settings', '/connect']) {
    const response = await get(path);
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
    const body = await response.text();
    assert.match(body, /Mile Ledger/, `${path} did not render the app shell`);
  }
});

test('static assets and health are served', async () => {
  assert.equal((await get('/app.css')).status, 200);
  assert.equal((await get('/app.js')).status, 200);
  assert.equal(await (await get('/healthz')).text(), 'ok');
});

test('an unknown path is a clean 404', async () => {
  assert.equal((await get('/nope')).status, 404);
});

test('labeling a place, importing history, and classifying all work over HTTP', async () => {
  const created = await post('/places', {
    name: 'Test Client Site',
    kind: 'address',
    label: 'business',
    purpose: 'Client work',
    client: 'Testco',
    latitude: '46.95',
    longitude: '-96.9',
    radiusMeters: '250',
    return: '/places',
  });
  assert.equal(created.status, 303);
  assert.match(await (await get('/places')).text(), /Test Client Site/);

  const home = await post('/places', {
    name: 'Test Home',
    kind: 'address',
    label: 'personal',
    isHome: '1',
    latitude: '46.8772',
    longitude: '-96.7898',
    radiusMeters: '250',
    return: '/places',
  });
  assert.equal(home.status, 303);

  const imported = await post('/import', {
    csv: [
      'timestamp,odometer,latitude,longitude,shift_state,speed',
      '2026-08-17 08:00:00,90000,46.8772,-96.7898,P,',
      '2026-08-17 08:10:00,90005,46.9000,-96.8500,D,45',
      '2026-08-17 08:20:00,90012,46.9500,-96.9000,D,20',
      '2026-08-17 08:23:00,90012,46.9500,-96.9000,P,',
      '2026-08-17 09:30:00,90012,46.9500,-96.9000,P,',
    ].join('\n'),
  });
  assert.equal(imported.status, 303);
  assert.match(decodeURIComponent(imported.headers.get('location') ?? ''), /imported 5/);

  const trips = repo.listTrips(app.db);
  assert.equal(trips.length, 1);
  const trip = trips[0];
  assert.ok(trip);
  assert.equal(trip.distanceMiles, 12);
  // The labels did their job without anyone being asked.
  assert.equal(trip.classification, 'business');
  assert.equal(trip.client, 'Testco');
  assert.equal(trip.endDescription, 'Test Client Site');

  // An explicit decision by the owner overrides it and sticks.
  const decided = await post(`/trips/${trip.id}/classify`, { classification: 'personal', return: '/trips' });
  assert.equal(decided.status, 303);
  const after = repo.getTrip(app.db, trip.id);
  assert.equal(after?.classification, 'personal');
  assert.equal(after?.locked, true);
});

test('a bad category is refused rather than stored', async () => {
  const trip = repo.listTrips(app.db)[0];
  assert.ok(trip);
  const response = await post(`/trips/${trip.id}/classify`, { classification: 'vacation', return: '/trips' });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location') ?? ''), /not one I know/);
  assert.equal(repo.getTrip(app.db, trip.id)?.classification, 'personal');
});

test('exports carry the trips and a summary', async () => {
  const csv = await get('/export/trips.csv?period=all');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition') ?? '', /attachment; filename="mileage-detail-all-time.csv"/);
  const csvBody = await csv.text();
  assert.match(csvBody, /^Date,Day,Start time/);
  assert.match(csvBody, /Test Client Site/);

  const summary = await get('/export/summary.csv?period=all');
  assert.match(await summary.text(), /Mileage summary/);

  const report = await get('/export/report?period=all');
  const reportBody = await report.text();
  assert.match(reportBody, /Vehicle Mileage Log/);
  assert.match(reportBody, /vehicle's own odometer/);

  const backup = await get('/export/backup.json');
  const parsed: unknown = JSON.parse(await backup.text());
  assert.ok(typeof parsed === 'object' && parsed !== null && 'trips' in parsed);
});

test('a share link is read-only, works without a session, and can be revoked', async () => {
  assert.equal((await post('/share', { name: 'CPA' })).status, 303);
  const token = repo.listShareLinks(app.db)[0]?.token;
  assert.ok(token);

  const page = await get(`/share/${token}`);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Read-only mileage log shared by the taxpayer/);
  assert.match(body, /Vehicle Mileage Log/);
  // No way to change anything from a share link.
  assert.equal(body.includes('/trips/'), false);
  assert.equal((await get(`/share/${token}/trips.csv?period=all`)).status, 200);
  assert.equal((await post(`/share/${token}`, {})).status, 404);

  assert.equal((await post(`/share/${token}/revoke`, {})).status, 303);
  assert.equal((await get(`/share/${token}`)).status, 404);
});

test('settings round-trip through the form', async () => {
  const response = await post('/settings', {
    business_name: 'Kaspar Companies',
    owner_name: 'Peter',
    vehicle_description: '2024 Tesla Model Y',
    timezone: 'America/Chicago',
    fallback_classification: 'unclassified',
    commute_handling: 'commute',
    credit_budget: '6000',
  });
  assert.equal(response.status, 303);
  const settings = app.settings();
  assert.equal(settings.businessName, 'Kaspar Companies');
  assert.equal(settings.creditBudget, 6000);
  assert.match(await (await get('/export/report?period=all')).text(), /Kaspar Companies/);
});

test('a rule added over HTTP is applied to trips already recorded', async () => {
  // Free the trip from its manual decision first.
  const trip = repo.listTrips(app.db)[0];
  assert.ok(trip);
  await post(`/trips/${trip.id}/unlock`, { return: '/trips' });

  const response = await post('/rules', {
    name: 'Monday mornings are business',
    classification: 'business',
    weekdays: '1',
    before: '12:00',
    priority: '10',
  });
  assert.equal(response.status, 303);

  // 2026-08-17 08:00 Central is a Monday morning.
  const after = repo.getTrip(app.db, trip.id);
  assert.equal(after?.classification, 'business');
  assert.equal(after?.classificationSource, 'rule');
  assert.match(after?.classificationReason ?? '', /Monday mornings are business/);
});

test('an added mileage rate changes what the export reports', async () => {
  const response = await post('/settings/rates', {
    from: '2026-08-01',
    to: '2026-08-31',
    business: '90',
    medical: '20',
    charity: '14',
    note: 'Made up, for the test',
  });
  assert.equal(response.status, 303);
  const csv = await (await get('/export/trips.csv?period=all')).text();
  // 12 miles at 90 cents.
  assert.match(csv, /90\.0,10\.80/);
});

test('every HTML response carries the security headers', async () => {
  const response = await get('/');
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/, 'no inline scripts are allowed');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

  // And the pages really do avoid inline handlers, or the policy would break them.
  const body = await response.text();
  assert.equal(/ on(click|change|submit)=/.test(body), false, 'found an inline event handler');
  assert.equal(/<script(?![^>]*src=)/.test(body), false, 'found an inline script');
});

test('a cross-origin write is refused', async () => {
  const response = await fetch(`${base}/appearance`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://evil.example',
    },
    body: new URLSearchParams({ colour: 'mono' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 403);
  // The setting was not changed.
  assert.equal(app.settings().colour, 'colour');
});

test('appearance is saved, applied server-side, and survives a fresh request', async () => {
  const saved = await post('/appearance', { appearance: 'dark', colour: 'mono' });
  assert.equal(saved.status, 303);
  assert.equal(app.settings().appearance, 'dark');
  assert.equal(app.settings().colour, 'mono');

  // Rendered onto the html element, so the first paint is already correct.
  for (const path of ['/', '/trips', '/places', '/rules', '/export', '/settings', '/more']) {
    const body = await (await get(path)).text();
    assert.match(body, /<html lang="en" data-appearance="dark" data-colour="mono">/, `${path} theme attributes`);
  }

  // The printable report follows it too.
  const report = await (await get('/export/report?period=all')).text();
  assert.match(report, /--chart-a: #2b2b2b/, 'the report uses the neutral chart palette');
  // Strictly neutral greys: every colour in the mono palette has equal channels.
  const tokens = [...report.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1] ?? '');
  const tinted = tokens.filter((hex) => {
    const channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((part) => parseInt(part, 16));
    return Math.max(...channels) - Math.min(...channels) > 2;
  });
  assert.deepEqual(tinted, [], `black and white mode still contains colour: ${tinted.join(', ')}`);

  // Back to colour for the rest of the tests.
  await post('/appearance', { appearance: 'system', colour: 'colour' });
  assert.equal(app.settings().colour, 'colour');
});

test('the phone navigation puts Dashboard in the middle and hides nothing behind it', async () => {
  const body = await (await get('/')).text();
  const bar = body.slice(body.indexOf('<nav class="bottom"'), body.indexOf('</nav>', body.indexOf('<nav class="bottom"')));
  const labels = [...bar.matchAll(/<\/span>([A-Za-z]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Trips', 'Places', 'Dashboard', 'Export', 'More']);
  // The centre item is the emphasised one.
  assert.match(bar, /<a href="\/" class="home"/);
  // The page reserves room for the bar, including the phone's home indicator.
  const css = await (await get('/app.css')).text();
  assert.match(css, /padding-bottom: calc\(var\(--bar-height\) \+ var\(--safe-bottom\)/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});

test('the More page reaches everything the bar does not', async () => {
  const body = await (await get('/more')).text();
  for (const href of ['/rules', '/places', '/connect', '/settings', '/export', '/trips?review=1']) {
    assert.ok(body.includes(`href="${href}"`), `More is missing a link to ${href}`);
  }
  assert.match(body, /Appearance/);
});

test('the JSON backup carries the ledger but not the secrets', async () => {
  const backup: unknown = JSON.parse(await (await get('/export/backup.json')).text());
  assert.ok(typeof backup === 'object' && backup !== null);
  const payload = backup as { settings: Record<string, string>; trips: unknown[] };
  assert.ok(Array.isArray(payload.trips));
  assert.equal('app_secret' in payload.settings, false, 'the session secret must not be exported');
  assert.equal('passcode_hash' in payload.settings, false, 'the passcode hash must not be exported');
  assert.ok('timezone' in payload.settings, 'ordinary settings are still exported');
  const raw = JSON.stringify(payload);
  assert.equal(raw.includes('scrypt:'), false);
});

test('setting a passcode locks the ledger, and signing in unlocks it', async () => {
  // Open until a passcode exists, because the app only listens on this machine.
  assert.equal((await get('/')).status, 200);

  assert.equal((await post('/settings/passcode', { passcode: 'a-real-passcode' })).status, 303);

  // Now every page redirects to the sign-in screen.
  const locked = await get('/trips');
  assert.equal(locked.status, 303);
  assert.equal(locked.headers.get('location'), '/login');
  // Including the exports, which are the sensitive part.
  assert.equal((await get('/export/backup.json')).status, 303);

  // A wrong passcode is refused.
  const wrong = await post('/login', { passcode: 'not it' });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /did not match/);
  assert.equal((await get('/trips')).status, 303, 'still locked after a failed attempt');

  // The right one issues a session.
  const right = await post('/login', { passcode: 'a-real-passcode' });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get('location'), '/');
  assert.equal((await get('/trips')).status, 200, 'signed in');

  // Signing out clears it again.
  assert.equal((await post('/logout', {})).status, 303);
  assert.equal((await get('/trips')).status, 303, 'signed out');

  // Sign back in and remove the passcode so the remaining tests are unaffected.
  await post('/login', { passcode: 'a-real-passcode' });
  assert.equal((await post('/settings/passcode', { passcode: '' })).status, 303);
  assert.equal((await get('/trips')).status, 200);
});

test('the share link keeps working while the ledger itself is locked', async () => {
  await post('/settings/passcode', { passcode: 'lock-it' });
  await post('/login', { passcode: 'lock-it' });
  await post('/share', { name: 'CPA while locked' });
  const token = repo.listShareLinks(app.db)[0]?.token;
  assert.ok(token);

  // A visitor with the link, and no session at all.
  const anonymous = await fetch(`${base}/share/${token}`, { redirect: 'manual' });
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /Vehicle Mileage Log/);
  // But that link is not a way into the app.
  assert.equal((await fetch(`${base}/trips`, { redirect: 'manual' })).status, 303);

  await post('/settings/passcode', { passcode: '' });
});

test('filtering by place uses the place, not a name match', async () => {
  // "Test Home" would also match a place called "Test Homestead" under a text search.
  const home = repo.listPlaces(app.db).find((place) => place.name === 'Test Home');
  assert.ok(home);
  const body = await (await get(`/trips?place=${home.id}`)).text();
  assert.match(body, /Showing only trips that started or ended at <strong>Test Home<\/strong>/);
  assert.match(body, /at Test Home/);
});

test('the served stylesheet and script are valid, not just present', async () => {
  // A syntax error in the client script disables every interactive behaviour on
  // the site at once — confirmations, the copy buttons, reading a CSV file,
  // double-submit protection — and the pages still render, so nothing looks
  // wrong. Parse what is actually served.
  const script = await (await get('/app.js')).text();
  assert.doesNotThrow(() => new Function(script), 'the served /app.js must parse');
  assert.ok(script.length > 500);
  // The delegated handlers the pages depend on.
  for (const hook of ['data-copy', 'data-more', 'data-confirm', 'data-file-into', 'data-autosubmit', 'data-print']) {
    assert.ok(script.includes(hook), `/app.js is missing the ${hook} handler`);
  }
  const css = await (await get('/app.css')).text();
  // Balanced braces is a cheap proof the sheet was not truncated mid-rule.
  const open = (css.match(/{/g) ?? []).length;
  const close = (css.match(/}/g) ?? []).length;
  assert.equal(open, close, 'the stylesheet has unbalanced braces');
  assert.ok(css.includes('data-colour="mono"'), 'the black and white palette is missing');
});

test('static assets revalidate instead of being re-sent', async () => {
  const first = await get('/app.css');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await fetch(`${base}/app.css`, { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
});

test('the dashboard renders a chart that does not need colour to be read', async () => {
  const body = await (await get('/')).text();
  if (!body.includes('<svg class="chart"')) return; // No months yet in this fixture.
  assert.match(body, /patternTransform="rotate\(45\)"/, 'the second series needs a texture');
  assert.match(body, /role="img"[\s\S]*?aria-label="Miles by month/, 'the chart needs a text alternative');
  assert.match(body, /class="legend"/, 'two series always need a legend');
  assert.match(body, /class="value"/, 'values are labelled directly');
});
