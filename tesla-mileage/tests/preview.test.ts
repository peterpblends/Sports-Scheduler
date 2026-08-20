import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';

// Preview mode is decided when the config module loads, so it is set first — the
// same way the serverless platform would have VERCEL set before any code runs.
process.env.VERCEL = '1';
process.env.MILE_LEDGER_PREVIEW = '1';
delete process.env.MILE_LEDGER_DURABLE_STORAGE;
process.env.MILE_LEDGER_GEOCODE = '0';
process.env.MILE_LEDGER_TZ = 'America/Chicago';
process.env.MILE_LEDGER_LOG = 'error';

const { config } = await import('../src/config.ts');
// The serverless entry point, exactly as Vercel invokes it.
const { default: handler } = await import('../api/index.ts');

let server: Server;
let base = '';

before(async () => {
  server = createServer((request, response) => handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(config.dbPath, { force: true });
  rmSync(`${config.dbPath}-wal`, { force: true });
  rmSync(`${config.dbPath}-shm`, { force: true });
});

test('a serverless host is recognised as having no permanent disk', () => {
  assert.equal(config.previewMode, true);
  // And the database is put somewhere writable rather than failing to open.
  assert.match(config.dbPath, /^\/tmp\//);
});

test('the serverless handler serves the whole app', async () => {
  for (const path of ['/', '/trips', '/places', '/rules', '/export', '/settings', '/more', '/connect']) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
    assert.match(await response.text(), /Mile Ledger/, `${path} did not render`);
  }
  // Assets and health too, so the pages are not unstyled.
  assert.equal((await fetch(`${base}/app.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
});

test('every page says plainly that nothing is kept', async () => {
  for (const path of ['/', '/trips', '/export', '/settings']) {
    const body = await (await fetch(`${base}${path}`, { redirect: 'manual' })).text();
    assert.match(body, /Preview — nothing here is kept/, `${path} is missing the warning`);
  }
});

test('a preview refuses to store Tesla credentials on a disk that will vanish', async () => {
  const response = await fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refreshToken: 'a-real-looking-token', mode: 'owner', region: 'na' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location') ?? ''), /will not accept a Tesla token/);

  // Nothing was written.
  const repo = await import('../src/db/repo.ts');
  const { db } = await import('../src/db/index.ts');
  assert.equal(repo.getToken(db(), 'owner'), null);
  assert.equal(repo.getToken(db(), 'fleet'), null);

  // And starting the official flow is refused as well.
  const oauth = await fetch(`${base}/connect/oauth/start`, { redirect: 'manual' });
  assert.equal(oauth.status, 303);
  assert.match(decodeURIComponent(oauth.headers.get('location') ?? ''), /disabled in this preview/);
});

test('a preview is loaded with demo data so every screen is usable', async () => {
  const repo = await import('../src/db/repo.ts');
  const { db } = await import('../src/db/index.ts');
  const trips = repo.listTrips(db(), { limit: 5 });
  assert.ok(trips.length > 0, 'expected demo trips');
  assert.equal(repo.listVehicles(db())[0]?.displayName, 'Demo Model Y');
  // The connector is forced to the simulator, so a preview never calls Tesla.
  const { readSettings } = await import('../src/settings.ts');
  assert.equal(readSettings(db()).connector, 'demo');
});

test('the exports still work in a preview, so the report can be shown to someone', async () => {
  const csv = await fetch(`${base}/export/trips.csv?period=all`);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /^Date,Day,Start time/);
  const report = await fetch(`${base}/export/report?period=ytd`);
  assert.match(await report.text(), /Vehicle Mileage Log/);
});

test('declaring durable storage turns preview mode off', async () => {
  // The escape hatch for a serverless host that really does have a disk.
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', '-e', "import('./src/config.ts').then(m => console.log(m.config.previewMode))"],
    { env: { ...process.env, VERCEL: '1', MILE_LEDGER_PREVIEW: '', MILE_LEDGER_DURABLE_STORAGE: '1' }, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'false');
});
