import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import { importCsv, parseCsv, detectKind, toIsoTimestamp } from '../src/tesla/importer.ts';

function fresh() {
  const db = openDatabase(':memory:');
  const vehicle = repo.upsertVehicle(db, { vin: 'IMPORT1', displayName: 'Imported Tesla' });
  return { db, vehicleId: vehicle.id };
}

test('quoted fields and Windows line endings survive parsing', () => {
  const rows = parseCsv('a,b\r\n1,"two, three"\r\n"say ""hi""",4\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', 'two, three'],
    ['say "hi"', '4'],
  ]);
});

test('a timestamp with no zone is read as the driver local time', () => {
  assert.equal(toIsoTimestamp('2026-08-17 14:32:00', 'America/Chicago'), '2026-08-17T19:32:00.000Z');
  assert.equal(toIsoTimestamp('8/17/2026 2:32 PM', 'America/Chicago'), '2026-08-17T19:32:00.000Z');
  // A stamp that carries its own offset is taken at face value.
  assert.equal(toIsoTimestamp('2026-08-17T14:32:00Z', 'America/Chicago'), '2026-08-17T14:32:00.000Z');
});

test('a readings export becomes trips through the normal stitching', () => {
  const { db, vehicleId } = fresh();
  const csv = [
    'timestamp,odometer,latitude,longitude,shift_state,speed',
    '2026-08-17 08:00:00,50000,46.8772,-96.7898,P,',
    '2026-08-17 08:10:00,50004,46.8900,-96.8100,D,42',
    '2026-08-17 08:20:00,50009.5,46.9022,-96.8009,D,25',
    '2026-08-17 08:24:00,50009.5,46.9022,-96.8009,P,',
    '2026-08-17 09:30:00,50009.5,46.9022,-96.8009,P,',
  ].join('\n');

  const report = importCsv(db, vehicleId, csv, { timezone: 'America/Chicago' });
  assert.equal(report.kind, 'readings');
  assert.equal(report.imported, 5);
  assert.equal(report.tripsCreated, 1);

  const trip = repo.listTrips(db)[0];
  assert.ok(trip);
  assert.equal(trip.distanceMiles, 9.5);
  // 08:00 Central is 13:00 UTC.
  assert.equal(trip.startedAt, '2026-08-17T13:00:00.000Z');
});

test('a trips export is taken as given, keeping categories already decided', () => {
  const { db, vehicleId } = fresh();
  const csv = [
    'start_date,end_date,distance_mi,start_address,end_address,category,purpose,client',
    '8/17/2026 8:00 AM,8/17/2026 8:25 AM,12.4,Home,Acme Warehouse,Business,Delivery,Acme',
    '8/17/2026 6:00 PM,8/17/2026 6:20 PM,9.1,Acme Warehouse,Home,Personal,,',
    '8/18/2026 9:00 AM,8/18/2026 9:30 AM,15,Home,Job site,,,',
  ].join('\n');

  const report = importCsv(db, vehicleId, csv, { timezone: 'America/Chicago' });
  assert.equal(report.kind, 'trips');
  assert.equal(report.imported, 3);

  const trips = repo.listTrips(db).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.equal(trips.length, 3);
  assert.equal(trips[0]?.classification, 'business');
  assert.equal(trips[0]?.locked, true);
  assert.equal(trips[0]?.client, 'Acme');
  assert.equal(trips[1]?.classification, 'personal');
  // A row with no category goes into the review queue rather than being guessed.
  assert.equal(trips[2]?.classification, 'unclassified');
  assert.equal(trips[2]?.needsReview, true);
});

test('re-importing the same file does not double up', () => {
  const { db, vehicleId } = fresh();
  const csv = [
    'start_date,end_date,distance_mi,category',
    '8/17/2026 8:00 AM,8/17/2026 8:25 AM,12.4,Business',
  ].join('\n');
  importCsv(db, vehicleId, csv, { timezone: 'America/Chicago' });
  importCsv(db, vehicleId, csv, { timezone: 'America/Chicago' });
  assert.equal(repo.listTrips(db).length, 1);
});

test('unusable rows are reported instead of silently dropped', () => {
  const { db, vehicleId } = fresh();
  const csv = [
    'timestamp,odometer',
    'not a date,50000',
    '2026-08-17 08:00:00,50000',
  ].join('\n');
  const report = importCsv(db, vehicleId, csv, { timezone: 'America/Chicago' });
  assert.equal(report.imported, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0] ?? '', /timestamp/);
});

test('a file with unrecognizable columns explains what it needs', () => {
  const { db, vehicleId } = fresh();
  const report = importCsv(db, vehicleId, 'colour,size\nred,large', {});
  assert.equal(report.kind, 'unknown');
  assert.equal(report.imported, 0);
  assert.match(report.problems[0] ?? '', /needs a timestamp and an odometer/);
});

test('column names from common Tesla tools are recognized', () => {
  assert.equal(detectKind(['date', 'odometer_mi', 'lat', 'lng']), 'readings');
  assert.equal(detectKind(['start_date', 'end_date', 'distance_mi']), 'trips');
  assert.equal(detectKind(['started_at', 'ended_at', 'miles', 'from', 'to']), 'trips');
});
