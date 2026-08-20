import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/export/summary.ts';
import { tripsCsv, summaryCsv, TRIP_COLUMNS } from '../src/export/csv.ts';
import { renderReport } from '../src/export/report.ts';
import { IRS_RATES } from '../src/domain/rates.ts';
import type { Classification, Trip } from '../src/domain/types.ts';

const TZ = 'America/Chicago';

let nextId = 1;
function trip(overrides: Partial<Trip> & { startedAt: string; distanceMiles: number; classification: Classification }): Trip {
  return {
    id: nextId++,
    vehicleId: 1,
    endedAt: overrides.startedAt,
    startLatitude: 46.87,
    startLongitude: -96.78,
    endLatitude: 46.95,
    endLongitude: -96.9,
    startOdometerMiles: 1000,
    endOdometerMiles: 1000 + overrides.distanceMiles,
    durationSeconds: 1500,
    startPlaceId: null,
    endPlaceId: null,
    startDescription: 'Home',
    endDescription: 'Acme Warehouse',
    classificationSource: 'user',
    classificationReason: 'Classified by you',
    confidence: 1,
    purpose: 'Client delivery',
    client: 'Acme',
    notes: null,
    locked: true,
    inferred: false,
    open: false,
    distanceSource: 'odometer',
    needsReview: false,
    signature: 'p1>p2',
    ...overrides,
  };
}

test('deduction uses the rate in force on each trip date, not one yearly rate', () => {
  const trips = [
    // June 2026: 72.5 cents. August 2026: 76 cents.
    trip({ startedAt: '2026-06-15T15:00:00Z', distanceMiles: 100, classification: 'business' }),
    trip({ startedAt: '2026-08-15T15:00:00Z', distanceMiles: 100, classification: 'business' }),
  ];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });

  assert.equal(summary.byClassification.business?.miles, 200);
  assert.equal(summary.deduction, 148.5); // 72.50 + 76.00
  assert.equal(summary.ratesApplied.length, 2);
});

test('commuting and personal miles are counted but never deducted', () => {
  const trips = [
    trip({ startedAt: '2026-08-03T14:00:00Z', distanceMiles: 20, classification: 'business' }),
    trip({ startedAt: '2026-08-03T22:00:00Z', distanceMiles: 12, classification: 'commute' }),
    trip({ startedAt: '2026-08-04T01:00:00Z', distanceMiles: 8, classification: 'personal' }),
  ];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });

  assert.equal(summary.totalMiles, 40);
  assert.equal(summary.byClassification.commute?.miles, 12);
  assert.equal(summary.byClassification.commute?.deduction, 0);
  assert.equal(summary.byClassification.personal?.deduction, 0);
  assert.equal(summary.deduction, Math.round(20 * 0.76 * 100) / 100);
  assert.equal(summary.businessPercent, 50);
});

test('uncategorized miles are surfaced, not folded into business', () => {
  const trips = [
    trip({ startedAt: '2026-08-03T14:00:00Z', distanceMiles: 10, classification: 'business' }),
    trip({
      startedAt: '2026-08-05T14:00:00Z',
      distanceMiles: 30,
      classification: 'unclassified',
      needsReview: true,
      locked: false,
    }),
  ];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });

  assert.equal(summary.unclassifiedTrips, 1);
  assert.equal(summary.byClassification.unclassified?.miles, 30);
  assert.equal(summary.deduction, 7.6);
});

test('trips are bucketed into the month the driver was actually in', () => {
  // 2026-09-01T02:00Z is still August 31 in Central time.
  const trips = [trip({ startedAt: '2026-09-01T02:00:00Z', distanceMiles: 10, classification: 'business' })];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });
  assert.equal(summary.months.length, 1);
  assert.equal(summary.months[0]?.month, '2026-08');
});

test('client totals roll up business trips only', () => {
  const trips = [
    trip({ startedAt: '2026-08-03T14:00:00Z', distanceMiles: 10, classification: 'business', client: 'Acme' }),
    trip({ startedAt: '2026-08-04T14:00:00Z', distanceMiles: 25, classification: 'business', client: 'Northport' }),
    trip({ startedAt: '2026-08-05T14:00:00Z', distanceMiles: 40, classification: 'personal', client: 'Acme' }),
  ];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });
  assert.equal(summary.clients.length, 2);
  assert.equal(summary.clients[0]?.name, 'Northport');
  assert.equal(summary.clients[0]?.miles, 25);
  assert.equal(summary.clients.find((c) => c.name === 'Acme')?.miles, 10);
});

test('the detail CSV carries what a mileage log has to show', () => {
  const csv = tripsCsv(
    [trip({ startedAt: '2026-08-17T13:00:00Z', distanceMiles: 12.4, classification: 'business' })],
    { timezone: TZ, rates: IRS_RATES },
  );
  const [header, row] = csv.trim().split('\n');
  assert.equal(header, TRIP_COLUMNS.join(','));
  assert.ok(row);
  assert.match(row, /^2026-08-17,Mon,8:00 AM/);
  assert.match(row, /12\.4,business,Client delivery,Acme/);
  assert.match(row, /76\.0,9\.42/); // rate and deduction
});

test('commas and quotes in a purpose do not break the CSV', () => {
  const csv = tripsCsv(
    [
      trip({
        startedAt: '2026-08-17T13:00:00Z',
        distanceMiles: 5,
        classification: 'business',
        purpose: 'Met "Bob", then dropped off parts',
      }),
    ],
    { timezone: TZ, rates: IRS_RATES },
  );
  assert.match(csv, /"Met ""Bob"", then dropped off parts"/);
});

test('the summary CSV includes months, clients and the rates used', () => {
  const trips = [trip({ startedAt: '2026-08-17T13:00:00Z', distanceMiles: 12.4, classification: 'business' })];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });
  const csv = summaryCsv(summary);
  assert.match(csv, /Business miles,12\.4/);
  assert.match(csv, /August 2026/);
  assert.match(csv, /Acme,1,12\.4/);
  assert.match(csv, /Business cents\/mile/);
});

test('the printable report states its method and excludes commuting', () => {
  const trips = [
    trip({ startedAt: '2026-08-17T13:00:00Z', distanceMiles: 12.4, classification: 'business' }),
    trip({ startedAt: '2026-08-17T22:00:00Z', distanceMiles: 6, classification: 'commute' }),
    trip({ startedAt: '2026-08-18T13:00:00Z', distanceMiles: 40, classification: 'business', inferred: true }),
  ];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });
  const html = renderReport(trips, summary, {
    timezone: TZ,
    rates: IRS_RATES,
    businessName: 'Kaspar Companies',
    ownerName: 'Peter',
    vehicleDescription: '2024 Tesla Model Y',
    periodLabel: '2026',
    includeDetail: true,
    includePersonal: false,
  });

  assert.match(html, /<title>Kaspar Companies — Vehicle Mileage Log<\/title>/);
  assert.match(html, /vehicle's own odometer/);
  assert.match(html, /not<\/strong> included in the deduction/);
  assert.match(html, /1 trip marked "reconstructed"/);
  assert.match(html, /Acme Warehouse/);
  assert.match(html, /76\.0&cent;\/mile/);
  // Deduction covers only the two business trips: 52.4 miles at 76 cents.
  assert.match(html, /\$39\.82/);
});

test('report escaping keeps injected markup inert', () => {
  const trips = [
    trip({
      startedAt: '2026-08-17T13:00:00Z',
      distanceMiles: 1,
      classification: 'business',
      endDescription: '<script>alert(1)</script>',
    }),
  ];
  const summary = summarize(trips, { timezone: TZ, rates: IRS_RATES });
  const html = renderReport(trips, summary, {
    timezone: TZ,
    rates: IRS_RATES,
    businessName: '',
    ownerName: '',
    vehicleDescription: '',
    periodLabel: '2026',
    includeDetail: true,
    includePersonal: true,
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('a corrected rate added later takes precedence over the broader one', () => {
  const periods = [
    ...IRS_RATES,
    { from: '2026-08-01', to: '2026-08-31', business: 90, medical: 20, charity: 14, note: 'Correction' },
  ];
  const trips = [trip({ startedAt: '2026-08-17T13:00:00Z', distanceMiles: 12, classification: 'business' })];
  const summary = summarize(trips, { timezone: TZ, rates: periods });
  assert.equal(summary.deduction, 10.8); // 12 miles at 90 cents, not 76

  // A date outside the correction still uses the standard period.
  const july = summarize(
    [trip({ startedAt: '2026-07-15T13:00:00Z', distanceMiles: 12, classification: 'business' })],
    { timezone: TZ, rates: periods },
  );
  assert.equal(july.deduction, 9.12); // 76 cents
});
