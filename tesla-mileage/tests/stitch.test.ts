import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stitchTrips } from '../src/domain/stitch.ts';
import type { Sample } from '../src/domain/types.ts';

const BASE = Date.UTC(2026, 7, 17, 12, 0, 0); // Aug 17 2026, noon UTC

type Reading = {
  minute: number;
  odometer: number;
  latitude?: number;
  longitude?: number;
  shift?: string | null;
  speed?: number | null;
  cached?: boolean;
};

function sample(reading: Reading): Sample {
  return {
    vehicleId: 1,
    at: new Date(BASE + reading.minute * 60_000).toISOString(),
    odometerMiles: reading.odometer,
    latitude: reading.latitude ?? 46.8772,
    longitude: reading.longitude ?? -96.7898,
    shiftState: reading.shift === undefined ? 'P' : reading.shift,
    speedMph: reading.speed ?? null,
    state: 'online',
    chargingState: null,
    batteryLevel: 70,
    cached: reading.cached ?? false,
    source: 'test',
  };
}

test('a single drive between two parkings becomes one trip', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 1000 }),
    sample({ minute: 5, odometer: 1002, shift: 'D', speed: 35 }),
    sample({ minute: 10, odometer: 1008, shift: 'D', speed: 45 }),
    sample({ minute: 15, odometer: 1012.4, latitude: 46.9, longitude: -96.83 }),
    sample({ minute: 45, odometer: 1012.4, latitude: 46.9, longitude: -96.83 }),
  ]);

  assert.equal(result.trips.length, 1);
  const trip = result.trips[0];
  assert.ok(trip);
  assert.equal(trip.distanceMiles, 12.4);
  assert.equal(trip.startOdometerMiles, 1000);
  assert.equal(trip.endOdometerMiles, 1012.4);
  assert.equal(trip.inferred, false);
  assert.equal(trip.open, false);
  assert.equal(trip.distanceSource, 'odometer');
  assert.equal(trip.durationSeconds, 15 * 60);
});

test('a park in the middle splits one drive into two trips', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 500 }),
    sample({ minute: 10, odometer: 506, shift: 'D', speed: 40 }),
    sample({ minute: 12, odometer: 506 }), // arrived and parked
    sample({ minute: 40, odometer: 506 }),
    sample({ minute: 50, odometer: 512, shift: 'D', speed: 40 }),
    sample({ minute: 55, odometer: 512 }),
    sample({ minute: 90, odometer: 512 }),
  ]);

  assert.equal(result.trips.length, 2);
  assert.equal(result.trips[0]?.distanceMiles, 6);
  assert.equal(result.trips[1]?.distanceMiles, 6);
});

test('a red light does not end a trip', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 100 }),
    sample({ minute: 2, odometer: 101, shift: 'D', speed: 30 }),
    sample({ minute: 3, odometer: 101, shift: 'D', speed: 0 }), // stopped, still in gear
    sample({ minute: 5, odometer: 104, shift: 'D', speed: 30 }),
    sample({ minute: 7, odometer: 106 }),
    sample({ minute: 40, odometer: 106 }),
  ]);

  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0]?.distanceMiles, 6);
});

test('parking-lot shuffle is discarded, not logged as a trip', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 100 }),
    sample({ minute: 2, odometer: 100.06, shift: 'D', speed: 3 }),
    sample({ minute: 4, odometer: 100.06 }),
    sample({ minute: 40, odometer: 100.06 }),
  ]);

  assert.equal(result.trips.length, 0);
  assert.ok(result.discardedMiles > 0);
  assert.ok(result.discardedMiles < 0.15);
});

test('miles driven across a polling gap are still captured, marked inferred', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 2000 }),
    // The car slept, we read cached data, and it turns up 40 miles away.
    sample({ minute: 120, odometer: 2040, latitude: 47.2, longitude: -97.1 }),
    sample({ minute: 150, odometer: 2040, latitude: 47.2, longitude: -97.1 }),
  ]);

  assert.equal(result.trips.length, 1);
  const trip = result.trips[0];
  assert.ok(trip);
  assert.equal(trip.inferred, true);
  assert.equal(trip.distanceMiles, 40);
  assert.equal(trip.open, false);
});

test('a drive still under way is returned as an open trip', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 10 }),
    sample({ minute: 3, odometer: 12, shift: 'D', speed: 40 }),
    sample({ minute: 6, odometer: 16, shift: 'D', speed: 55 }),
  ]);

  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0]?.open, true);
  assert.equal(result.trips[0]?.distanceMiles, 6);
});

test('logged miles reconcile with the odometer', () => {
  const readings: Sample[] = [];
  let odometer = 30_000;
  for (let minute = 0; minute <= 600; minute += 5) {
    // Drive for the first half of each hour, park for the rest.
    const driving = minute % 60 < 30 && minute > 0;
    if (driving) odometer += 3.4;
    readings.push(
      sample({
        minute,
        odometer: Number(odometer.toFixed(3)),
        shift: driving ? 'D' : 'P',
        speed: driving ? 41 : null,
      }),
    );
  }
  const result = stitchTrips(readings);
  const logged = result.trips.reduce((sum, t) => sum + t.distanceMiles, 0);

  assert.ok(result.trips.length >= 9, `expected several trips, got ${result.trips.length}`);
  assert.equal(
    Math.round((logged + result.discardedMiles) * 100) / 100,
    Math.round(result.odometerMiles * 100) / 100,
  );
});

test('a long park produces no trips at all', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 77 }),
    sample({ minute: 240, odometer: 77 }),
    sample({ minute: 900, odometer: 77 }),
  ]);
  assert.equal(result.trips.length, 0);
  assert.equal(result.odometerMiles, 0);
});

test('out-of-order and duplicate readings are tolerated', () => {
  const ordered = [
    sample({ minute: 0, odometer: 1 }),
    sample({ minute: 4, odometer: 3, shift: 'D', speed: 30 }),
    sample({ minute: 8, odometer: 6 }),
    sample({ minute: 40, odometer: 6 }),
  ];
  const scrambled = [ordered[3]!, ordered[1]!, ordered[1]!, ordered[0]!, ordered[2]!];
  const result = stitchTrips(scrambled);
  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0]?.distanceMiles, 5);
});

test('a bad odometer reading never creates negative distance', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 900 }),
    sample({ minute: 5, odometer: 100 }), // corrupt reading
    sample({ minute: 10, odometer: 902, shift: 'D', speed: 30 }),
    sample({ minute: 15, odometer: 902 }),
    sample({ minute: 60, odometer: 902 }),
  ]);
  for (const trip of result.trips) assert.ok(trip.distanceMiles >= 0);
  assert.ok(result.odometerMiles >= 0);
});

test('a gap in the middle of a drive extends the same trip instead of splitting it', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 300 }),
    sample({ minute: 5, odometer: 304, shift: 'D', speed: 45 }),
    // Polling stalled for 20 minutes while the car kept going.
    sample({ minute: 25, odometer: 322, shift: 'D', speed: 50 }),
    sample({ minute: 30, odometer: 326, latitude: 47.1, longitude: -97.0 }),
    sample({ minute: 70, odometer: 326, latitude: 47.1, longitude: -97.0 }),
  ]);

  assert.equal(result.trips.length, 1);
  const trip = result.trips[0];
  assert.ok(trip);
  assert.equal(trip.distanceMiles, 26);
  assert.equal(trip.inferred, true, 'the missing stretch is disclosed');
});

test('a gap that ends with the car parked somewhere new is its own trip', () => {
  const result = stitchTrips([
    sample({ minute: 0, odometer: 300 }),
    sample({ minute: 5, odometer: 303, shift: 'D', speed: 40 }),
    sample({ minute: 9, odometer: 306 }), // arrived, parked
    sample({ minute: 200, odometer: 340, latitude: 47.3, longitude: -97.4 }), // moved while asleep
    sample({ minute: 240, odometer: 340, latitude: 47.3, longitude: -97.4 }),
  ]);

  assert.equal(result.trips.length, 2);
  assert.equal(result.trips[0]?.inferred, false);
  assert.equal(result.trips[0]?.distanceMiles, 6);
  assert.equal(result.trips[1]?.inferred, true);
  assert.equal(result.trips[1]?.distanceMiles, 34);
});
