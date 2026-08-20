import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import { summarize } from '../src/export/summary.ts';
import { aggregateSummary } from '../src/export/aggregate.ts';
import { IRS_RATES } from '../src/domain/rates.ts';
import { localYearRange } from '../src/lib/time.ts';
import type { Classification } from '../src/domain/types.ts';

const TZ = 'America/Chicago';

function seed(count: number, options: { spanDays: number; startMs: number }) {
  const db = openDatabase(':memory:');
  const vehicle = repo.upsertVehicle(db, { vin: 'AGG', displayName: 'Aggregate' });
  const categories: Classification[] = ['business', 'personal', 'commute', 'unclassified', 'medical', 'charity'];
  const stepMs = (options.spanDays * 86_400_000) / count;

  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(options.startMs + i * stepMs).toISOString();
      const category = categories[i % categories.length] ?? 'business';
      repo.upsertTrip(db, {
        vehicleId: vehicle.id,
        startedAt: at,
        endedAt: new Date(options.startMs + i * stepMs + 900_000).toISOString(),
        startLatitude: 46.87, startLongitude: -96.78, endLatitude: 46.95, endLongitude: -96.9,
        startOdometerMiles: i * 20, endOdometerMiles: i * 20 + 7.3,
        // Vary the distance so rounding differences would show up.
        distanceMiles: Math.round((3 + (i % 17) * 1.37) * 10) / 10,
        durationSeconds: 900, startPlaceId: null, endPlaceId: null,
        startDescription: 'Home', endDescription: `Site ${i % 5}`,
        classification: category,
        classificationSource: 'place', classificationReason: 'test',
        confidence: 0.9, purpose: null, client: `Client ${i % 3}`, notes: null,
        locked: false, inferred: false, open: false, distanceSource: 'odometer',
        needsReview: i % 7 === 0, signature: null,
      });
    }
  });
  return { db, vehicleId: vehicle.id };
}

/** The two implementations must not drift apart. */
function assertAgrees(db: ReturnType<typeof openDatabase>, window: { from?: string; to?: string }) {
  const rates = repo.ratePeriods(db);
  const rows = repo.tripsForExport(db, window);
  const expected = summarize(rows, { timezone: TZ, rates });
  const actual = aggregateSummary(db, { timezone: TZ, rates, ...window });

  assert.equal(actual.totalTrips, expected.totalTrips, 'trip count');
  assert.equal(actual.totalMiles, expected.totalMiles, 'total miles');
  assert.equal(actual.deduction, expected.deduction, 'deduction');
  assert.equal(actual.businessPercent, expected.businessPercent, 'business share');
  assert.equal(actual.unclassifiedTrips, expected.unclassifiedTrips, 'unclassified count');
  assert.equal(actual.reviewTrips, expected.reviewTrips, 'review count');

  for (const key of Object.keys(expected.byClassification) as Classification[]) {
    const a = actual.byClassification[key];
    const e = expected.byClassification[key];
    assert.equal(a?.trips, e?.trips, `${key} trips`);
    assert.equal(a?.miles, e?.miles, `${key} miles`);
    assert.equal(a?.deduction, e?.deduction, `${key} deduction`);
  }

  assert.equal(actual.months.length, expected.months.length, 'month count');
  for (const [index, month] of expected.months.entries()) {
    const got = actual.months[index];
    assert.equal(got?.month, month.month, 'month key');
    assert.equal(got?.label, month.label, 'month label');
    assert.equal(got?.totalMiles, month.totalMiles, `${month.month} total miles`);
    assert.equal(got?.business.miles, month.business.miles, `${month.month} business miles`);
    assert.equal(got?.business.deduction, month.business.deduction, `${month.month} business deduction`);
    assert.equal(got?.commute.miles, month.commute.miles, `${month.month} commute miles`);
    assert.equal(got?.unclassified.miles, month.unclassified.miles, `${month.month} unclassified miles`);
  }

  assert.deepEqual(
    actual.ratesApplied.map((r) => r.from),
    expected.ratesApplied.map((r) => r.from),
    'rate periods applied',
  );
}

test('aggregate totals match the per-trip totals across a whole year', () => {
  const { db } = seed(600, { spanDays: 360, startMs: Date.UTC(2026, 0, 2, 9, 0, 0) });
  const year = localYearRange(2026, TZ);
  assertAgrees(db, year);
});

test('aggregate totals match across a mid-year IRS rate change', () => {
  // 2026 changes on July 1: 72.5 cents before, 76 after.
  const { db } = seed(200, { spanDays: 40, startMs: Date.UTC(2026, 5, 10, 9, 0, 0) });
  const rates = repo.ratePeriods(db);
  const window = { from: '2026-06-01T05:00:00.000Z', to: '2026-08-01T05:00:00.000Z' };
  assertAgrees(db, window);
  // And the change is genuinely inside the window.
  const actual = aggregateSummary(db, { timezone: TZ, rates, ...window });
  assert.equal(actual.ratesApplied.length, 2, 'both rate periods should be reported');
});

test('aggregate totals match with no window at all', () => {
  const { db } = seed(150, { spanDays: 700, startMs: Date.UTC(2025, 2, 3, 12, 0, 0) });
  assertAgrees(db, {});
});

test('aggregate totals match for a single day', () => {
  const { db } = seed(20, { spanDays: 1, startMs: Date.UTC(2026, 7, 17, 6, 0, 0) });
  assertAgrees(db, { from: '2026-08-17T05:00:00.000Z', to: '2026-08-18T05:00:00.000Z' });
});

test('aggregate totals match when a filter is applied', () => {
  const { db } = seed(120, { spanDays: 90, startMs: Date.UTC(2026, 3, 1, 9, 0, 0) });
  const rates = repo.ratePeriods(db);
  const window = { from: '2026-04-01T05:00:00.000Z', to: '2026-07-01T05:00:00.000Z' };

  for (const classification of ['business', 'personal', 'unclassified'] as Classification[]) {
    const rows = repo.tripsForExport(db, { ...window, classification });
    const expected = summarize(rows, { timezone: TZ, rates });
    const actual = aggregateSummary(db, {
      timezone: TZ,
      rates,
      ...window,
      filter: { classification },
    });
    assert.equal(actual.totalMiles, expected.totalMiles, `${classification} miles`);
    assert.equal(actual.deduction, expected.deduction, `${classification} deduction`);
    assert.equal(actual.totalTrips, expected.totalTrips, `${classification} trips`);
  }

  const reviewRows = repo.tripsForExport(db, { ...window, needsReview: true });
  const reviewExpected = summarize(reviewRows, { timezone: TZ, rates });
  const reviewActual = aggregateSummary(db, {
    timezone: TZ,
    rates,
    ...window,
    filter: { needsReview: true },
  });
  assert.equal(reviewActual.totalTrips, reviewExpected.totalTrips, 'review-only trips');
  assert.equal(reviewActual.totalMiles, reviewExpected.totalMiles, 'review-only miles');
});

test('an empty ledger aggregates to zero rather than throwing', () => {
  const db = openDatabase(':memory:');
  repo.seedRates(db);
  const summary = aggregateSummary(db, { timezone: TZ, rates: IRS_RATES });
  assert.equal(summary.totalTrips, 0);
  assert.equal(summary.totalMiles, 0);
  assert.equal(summary.deduction, 0);
  assert.equal(summary.months.length, 0);
  assert.equal(summary.businessPercent, 0);
});
