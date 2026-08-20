import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import { SETTING_KEYS, writeSettings, readSettings } from '../src/settings.ts';
import {
  rebuildTrips,
  reclassifyAll,
  decideTrip,
  refreshSuggestions,
  acceptSuggestion,
} from '../src/domain/pipeline.ts';
import type { Sample, Place } from '../src/domain/types.ts';

const HOME = { latitude: 46.8772, longitude: -96.7898 };
const WAREHOUSE = { latitude: 46.95, longitude: -96.9 };
const GROCERY = { latitude: 46.86, longitude: -96.77 };
const BASE = Date.UTC(2026, 7, 17, 12, 0, 0);

function fresh() {
  const db = openDatabase(':memory:');
  db.putSetting(SETTING_KEYS.timezone, 'America/Chicago');
  repo.seedRates(db);
  const vehicle = repo.upsertVehicle(db, { vin: '5YJ3E1EA1KF000001', displayName: 'Model Y' });
  return { db, vehicleId: vehicle.id };
}

type Leg = { fromMinute: number; toMinute: number; from: typeof HOME; to: typeof HOME; miles: number };

/**
 * Build a plausible run of readings: parked, then sampled every few minutes
 * while driving (what the poller actually does), then parked again.
 */
function readings(vehicleId: number, legs: Leg[], odometerStart = 10_000): Sample[] {
  const out: Sample[] = [];
  let odometer = odometerStart;
  const push = (minute: number, at: typeof HOME, shift: string | null, speed: number | null) => {
    out.push({
      vehicleId,
      at: new Date(BASE + minute * 60_000).toISOString(),
      odometerMiles: Number(odometer.toFixed(3)),
      latitude: at.latitude,
      longitude: at.longitude,
      shiftState: shift,
      speedMph: speed,
      state: 'online',
      chargingState: null,
      batteryLevel: 68,
      cached: false,
      source: 'test',
    });
  };

  for (const leg of legs) {
    // Sitting parked at the origin right up to departure.
    push(leg.fromMinute - 10, leg.from, 'P', null);
    push(leg.fromMinute, leg.from, 'P', null);

    // Under way: a reading every 5 minutes, odometer climbing evenly.
    const driveMinutes = Math.max(5, leg.toMinute - leg.fromMinute);
    const steps = Math.max(2, Math.round(driveMinutes / 5));
    for (let step = 1; step <= steps; step += 1) {
      odometer += leg.miles / steps;
      const minute = leg.fromMinute + Math.round((driveMinutes * step) / steps);
      const arrived = step === steps;
      push(minute, arrived ? leg.to : leg.from, 'D', arrived ? 20 : 45);
    }

    // Parked at the destination.
    push(leg.toMinute + 2, leg.to, 'P', null);
    push(leg.toMinute + 20, leg.to, 'P', null);
  }
  return out;
}

function place(db: ReturnType<typeof openDatabase>, input: Partial<Place> & { name: string }) {
  return repo.createPlace(db, {
    kind: 'address',
    label: 'business',
    purpose: null,
    client: null,
    address: null,
    city: null,
    region: null,
    postal: null,
    latitude: null,
    longitude: null,
    radiusMeters: 250,
    isHome: false,
    isPrimaryOffice: false,
    notes: null,
    ...input,
  });
}

test('readings become trips, and labeling an address fixes them retroactively', () => {
  const { db, vehicleId } = fresh();
  const samples = readings(vehicleId, [
    { fromMinute: 0, toMinute: 30, from: HOME, to: WAREHOUSE, miles: 14.2 },
    { fromMinute: 120, toMinute: 150, from: WAREHOUSE, to: HOME, miles: 14.2 },
  ]);
  for (const sample of samples) repo.insertSample(db, sample);

  // Nothing is labeled yet, so both trips wait for a human.
  const first = rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  assert.equal(first.created, 2);
  const pending = repo.listTrips(db);
  assert.equal(pending.length, 2);
  for (const trip of pending) {
    assert.equal(trip.classification, 'unclassified');
    assert.equal(trip.needsReview, true);
  }
  assert.equal(Math.round((pending[0]?.distanceMiles ?? 0) * 10) / 10, 14.2);

  // Label the two ends. Both existing trips should sort themselves out.
  place(db, { name: 'Home', label: 'personal', isHome: true, ...HOME });
  place(db, {
    name: 'Acme Warehouse',
    label: 'business',
    purpose: 'Client delivery',
    client: 'Acme',
    ...WAREHOUSE,
  });
  const result = reclassifyAll(db);
  assert.equal(result.examined, 2);
  assert.equal(result.changed, 2);

  const trips = repo.listTrips(db).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const outbound = trips[0];
  const inbound = trips[1];
  assert.ok(outbound && inbound);
  assert.equal(outbound.classification, 'business');
  assert.equal(outbound.startDescription, 'Home');
  assert.equal(outbound.endDescription, 'Acme Warehouse');
  assert.equal(outbound.client, 'Acme');
  assert.equal(outbound.purpose, 'Client delivery');
  assert.equal(outbound.needsReview, false);
  // The drive home from a client is the return leg of the same business trip.
  assert.equal(inbound.classification, 'business');
  assert.match(inbound.classificationReason ?? '', /Return leg/);
});

test('re-running the pipeline does not duplicate trips', () => {
  const { db, vehicleId } = fresh();
  for (const sample of readings(vehicleId, [
    { fromMinute: 0, toMinute: 25, from: HOME, to: WAREHOUSE, miles: 9 },
  ])) {
    repo.insertSample(db, sample);
  }
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  const again = rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  assert.equal(again.created, 0);
  assert.equal(again.updated, 1);
  assert.equal(repo.listTrips(db).length, 1);
});

test('a decision by the owner survives every later pass', () => {
  const { db, vehicleId } = fresh();
  for (const sample of readings(vehicleId, [
    { fromMinute: 0, toMinute: 25, from: HOME, to: GROCERY, miles: 4 },
  ])) {
    repo.insertSample(db, sample);
  }
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  const trip = repo.listTrips(db)[0];
  assert.ok(trip);

  decideTrip(db, trip.id, { classification: 'business', purpose: 'Picked up job-site supplies' });

  // Label the destination personal, which would otherwise flip it.
  place(db, { name: 'Grocery', label: 'personal', ...GROCERY });
  reclassifyAll(db);
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const after = repo.getTrip(db, trip.id);
  assert.ok(after);
  assert.equal(after.classification, 'business');
  assert.equal(after.classificationSource, 'user');
  assert.equal(after.locked, true);
  assert.equal(after.purpose, 'Picked up job-site supplies');
  assert.equal(after.needsReview, false);
});

test('repeated manual decisions turn into a proposal, and accepting it automates the route', () => {
  const { db, vehicleId } = fresh();
  place(db, { name: 'Home', label: 'personal', isHome: true, ...HOME });

  // Three separate visits to the same unlabeled address, all called business.
  const legs: Leg[] = [];
  for (let day = 0; day < 3; day += 1) {
    legs.push({
      fromMinute: day * 600,
      toMinute: day * 600 + 30,
      from: HOME,
      to: WAREHOUSE,
      miles: 14,
    });
    legs.push({
      fromMinute: day * 600 + 200,
      toMinute: day * 600 + 230,
      from: WAREHOUSE,
      to: HOME,
      miles: 14,
    });
  }
  for (const sample of readings(vehicleId, legs)) repo.insertSample(db, sample);
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const outbound = repo
    .listTrips(db)
    .filter((trip) => trip.endDescription !== 'Home')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.ok(outbound.length >= 3);

  for (const trip of outbound.slice(0, 3)) {
    decideTrip(db, trip.id, { classification: 'business', client: 'Acme' });
  }

  const suggestions = repo.listSuggestions(db);
  assert.ok(suggestions.length > 0, 'expected at least one proposal');

  const route = suggestions.find((s) => s.signature.startsWith('route:'));
  assert.ok(route, 'expected a route proposal');
  assert.equal(route.classification, 'business');
  assert.ok(route.observations >= 3);

  // A place proposal is offered too, since the destination is still unlabeled.
  const placeSuggestion = suggestions.find((s) => s.signature.startsWith('place:'));
  assert.ok(placeSuggestion, 'expected a proposal to label the address');

  const accepted = acceptSuggestion(db, route.id);
  assert.ok(accepted && accepted.kind === 'route');
  const rule = repo.getRule(db, accepted.ruleId);
  assert.ok(rule);
  assert.equal(rule.source, 'learned');
  assert.equal(rule.classification, 'business');

  // A brand new trip on that same route is now classified without being asked.
  const laterSamples = readings(
    vehicleId,
    [{ fromMinute: 5000, toMinute: 5030, from: HOME, to: WAREHOUSE, miles: 14 }],
    50_000,
  );
  for (const sample of laterSamples) repo.insertSample(db, sample);
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const newest = repo.listTrips(db)[0];
  assert.ok(newest);
  assert.equal(newest.classification, 'business');
  assert.equal(newest.classificationSource, 'learned');
  assert.equal(newest.needsReview, false);
});

test('a proposal that was dismissed stays dismissed', () => {
  const { db, vehicleId } = fresh();
  place(db, { name: 'Home', label: 'personal', isHome: true, ...HOME });
  for (const sample of readings(vehicleId, [
    { fromMinute: 0, toMinute: 30, from: HOME, to: WAREHOUSE, miles: 14 },
    { fromMinute: 300, toMinute: 330, from: HOME, to: WAREHOUSE, miles: 14 },
  ])) {
    repo.insertSample(db, sample);
  }
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  for (const trip of repo.listTrips(db)) {
    decideTrip(db, trip.id, { classification: 'business' });
  }
  const open = repo.listSuggestions(db);
  assert.ok(open.length > 0);
  const target = open[0];
  assert.ok(target);
  repo.setSuggestionStatus(db, target.id, 'dismissed');

  refreshSuggestions(db);
  assert.equal(
    repo.listSuggestions(db).some((s) => s.id === target.id),
    false,
  );
});

test('automatic learning can be turned on, and then no proposal is needed', () => {
  const { db, vehicleId } = fresh();
  db.putSetting(SETTING_KEYS.autoApplyLearned, '1');
  place(db, { name: 'Home', label: 'personal', isHome: true, ...HOME });
  for (const sample of readings(vehicleId, [
    { fromMinute: 0, toMinute: 30, from: HOME, to: WAREHOUSE, miles: 14 },
    { fromMinute: 300, toMinute: 330, from: HOME, to: WAREHOUSE, miles: 14 },
  ])) {
    repo.insertSample(db, sample);
  }
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  for (const trip of repo.listTrips(db)) {
    decideTrip(db, trip.id, { classification: 'business' });
  }

  const learned = repo.listRules(db).filter((rule) => rule.source === 'learned');
  assert.ok(learned.length > 0, 'expected a rule to be created automatically');
});

test('miles driven while the app was not watching still land in the ledger', () => {
  const { db, vehicleId } = fresh();
  const iso = (minute: number) => new Date(BASE + minute * 60_000).toISOString();
  const base = {
    vehicleId,
    shiftState: 'P',
    speedMph: null,
    state: 'asleep',
    chargingState: null,
    batteryLevel: 55,
    cached: true,
    source: 'test',
  };
  // Two cached readings three hours apart: the car went somewhere in between.
  repo.insertSample(db, { ...base, at: iso(0), odometerMiles: 22_000, ...HOME });
  repo.insertSample(db, { ...base, at: iso(180), odometerMiles: 22_061.4, ...WAREHOUSE });
  repo.insertSample(db, { ...base, at: iso(240), odometerMiles: 22_061.4, ...WAREHOUSE });

  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  const trip = repo.listTrips(db)[0];
  assert.ok(trip);
  assert.equal(trip.inferred, true);
  assert.equal(Math.round(trip.distanceMiles * 10) / 10, 61.4);
});

test('a purpose you typed is kept; one derived from a label refreshes when labels change', () => {
  const { db, vehicleId } = fresh();
  for (const sample of readings(vehicleId, [
    { fromMinute: 0, toMinute: 25, from: HOME, to: WAREHOUSE, miles: 9 },
    { fromMinute: 300, toMinute: 325, from: HOME, to: GROCERY, miles: 4 },
  ])) {
    repo.insertSample(db, sample);
  }
  place(db, { name: 'Home', label: 'personal', isHome: true, ...HOME });
  place(db, { name: 'First Client', label: 'business', purpose: 'Old purpose', client: 'First', ...WAREHOUSE });
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const toWarehouse = repo.listTrips(db).find((trip) => trip.endDescription === 'First Client');
  const toGrocery = repo.listTrips(db).find((trip) => trip.endDescription !== 'First Client');
  assert.ok(toWarehouse && toGrocery);
  assert.equal(toWarehouse.purpose, 'Old purpose');

  // The owner types a purpose on the second trip.
  repo.setTripFields(db, toGrocery.id, { purpose: 'Bought job-site supplies', client: 'Mine', notes: null });

  // The label's own purpose is corrected.
  const client = repo.listPlaces(db).find((p) => p.name === 'First Client');
  assert.ok(client);
  repo.updatePlace(db, client.id, { ...client, purpose: 'Corrected purpose', client: 'First Client Inc' });
  reclassifyAll(db);

  const refreshed = repo.getTrip(db, toWarehouse.id);
  const typed = repo.getTrip(db, toGrocery.id);
  assert.ok(refreshed && typed);
  // Derived from a label, so it follows the label.
  assert.equal(refreshed.purpose, 'Corrected purpose');
  assert.equal(refreshed.client, 'First Client Inc');
  // Typed by hand, so nothing automatic touches it.
  assert.equal(typed.purpose, 'Bought job-site supplies');
  assert.equal(typed.client, 'Mine');
});

test('a drive that turns out to have started earlier stays one trip, not two', () => {
  // The tax-relevant case: readings arrive late or out of order, the stitcher
  // places the same drive a few minutes earlier, and the miles must not be
  // counted twice.
  const { db, vehicleId } = fresh();
  const iso = (minute: number) => new Date(BASE + minute * 60_000).toISOString();
  const reading = (minute: number, odometer: number, shift: string, spot: typeof HOME) => ({
    vehicleId,
    at: iso(minute),
    odometerMiles: odometer,
    latitude: spot.latitude,
    longitude: spot.longitude,
    shiftState: shift,
    speedMph: shift === 'D' ? 40 : null,
    state: 'online',
    chargingState: null,
    batteryLevel: 60,
    cached: false,
    source: 'test',
  });

  // First pass sees only the tail of the drive.
  repo.insertSample(db, reading(10, 100, 'D', HOME));
  repo.insertSample(db, reading(20, 112, 'D', WAREHOUSE));
  repo.insertSample(db, reading(24, 112, 'P', WAREHOUSE));
  repo.insertSample(db, reading(70, 112, 'P', WAREHOUSE));
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const first = repo.listTrips(db);
  assert.equal(first.length, 1);
  const original = first[0];
  assert.ok(original);
  decideTrip(db, original.id, { classification: 'business', purpose: 'Delivery' });

  // A backfill supplies the beginning of that same drive.
  repo.insertSample(db, reading(4, 96, 'P', HOME));
  repo.insertSample(db, reading(7, 98, 'D', HOME));
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const after = repo.listTrips(db);
  assert.equal(after.length, 1, 'one drive must remain one trip');
  const merged = after[0];
  assert.ok(merged);
  // The odometer moved 96 -> 112, so the ledger must say 16 miles, not 28.
  assert.equal(merged.distanceMiles, 16);
  assert.equal(merged.startOdometerMiles, 96);
  // And the owner's decision survived the correction.
  assert.equal(merged.classification, 'business');
  assert.equal(merged.locked, true);
  assert.equal(merged.purpose, 'Delivery');
});

test('rebuilding after old readings are pruned does not erase the older trips', () => {
  const { db, vehicleId } = fresh();
  // One run of readings covering a drive today and another a month later, so the
  // odometer climbs continuously the way a real car's does.
  for (const sample of readings(vehicleId, [
    { fromMinute: 0, toMinute: 25, from: HOME, to: WAREHOUSE, miles: 15 },
    { fromMinute: 30 * 1440, toMinute: 30 * 1440 + 25, from: WAREHOUSE, to: HOME, miles: 10 },
  ])) {
    repo.insertSample(db, sample);
  }
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');
  assert.equal(repo.listTrips(db).length, 2);

  // Retention prunes the older readings; trips are meant to be kept forever.
  repo.pruneSamples(db, new Date(BASE + 29 * 1440 * 60_000).toISOString());
  rebuildTrips(db, vehicleId, '1970-01-01T00:00:00.000Z');

  const after = repo.listTrips(db);
  assert.equal(after.length, 2, 'a trip whose readings were pruned must survive a rebuild');
  assert.equal(
    Math.round(after.reduce((sum, trip) => sum + trip.distanceMiles, 0)),
    25,
  );
});

test('a time zone Intl cannot parse is refused and never reaches rendering', () => {
  const { db } = fresh();
  const refused = writeSettings(db, { timezone: 'Mars/Olympus_Mons' });
  assert.equal(refused.length, 1);
  assert.match(refused[0] ?? '', /not a time zone name/);
  assert.equal(readSettings(db).timezone, 'America/Chicago');

  // Even if a bad value gets in some other way, reading settings must not throw.
  db.putSetting('timezone', 'Nonsense/Zone');
  assert.equal(readSettings(db).timezone !== 'Nonsense/Zone', true);
  assert.doesNotThrow(() => readSettings(db));
});
