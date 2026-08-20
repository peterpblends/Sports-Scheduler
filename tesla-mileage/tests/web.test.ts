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

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: 'manual' });
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
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
