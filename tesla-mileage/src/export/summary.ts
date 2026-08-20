/**
 * Totals for the accountant.
 *
 * Deduction is computed trip by trip at the rate in force on that trip's local
 * date, then added up — not by multiplying a yearly total by one rate. That
 * matters in a year like 2026, where the business rate changed on July 1.
 */
import type { Classification, Trip } from '../domain/types.ts';
import { rateCents, type RatePeriod } from '../domain/rates.ts';
import { localDate, localMonth, monthLabel } from '../lib/time.ts';

export type Totals = { trips: number; miles: number; deduction: number };

function emptyTotals(): Totals {
  return { trips: 0, miles: 0, deduction: 0 };
}

/**
 * Accumulate at full precision and round once, at the end.
 *
 * Rounding as you go compounds the error: three 0.05-mile hops rounded to a
 * tenth each become 0.3 instead of 0.2. Distances are stored to three decimals,
 * so that mattered.
 *
 * Money is different again, and it is handled as integer cents. Each trip's
 * deduction is rounded to a whole cent — those per-trip amounts are what the CSV
 * prints, and an accountant adding the column up has to reach the total on the
 * report — and whole cents then sum exactly. Adding dollars as floating point
 * instead leaves totals that land on a half cent at the mercy of rounding noise,
 * which is how the same drive can be worth a cent more depending on the order it
 * was added in.
 *
 * While a pass is running, `deduction` holds integer cents. `finalize` converts
 * it to dollars, and every caller sees dollars.
 */
function add(totals: Totals, miles: number, deductionCents: number): void {
  totals.trips += 1;
  totals.miles += miles;
  totals.deduction += deductionCents;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finalize(totals: Totals): Totals {
  totals.miles = round(totals.miles);
  totals.deduction = round2(totals.deduction / 100);
  return totals;
}

export type MonthRow = {
  month: string;
  label: string;
  business: Totals;
  personal: Totals;
  commute: Totals;
  other: Totals;
  unclassified: Totals;
  totalMiles: number;
};

export type NamedRow = { name: string; trips: number; miles: number; deduction: number };

export type Summary = {
  timezone: string;
  from: string | null;
  to: string | null;
  totalTrips: number;
  totalMiles: number;
  byClassification: Record<Classification, Totals>;
  months: MonthRow[];
  clients: NamedRow[];
  destinations: NamedRow[];
  /** Sum of deductible categories at their own rates. */
  deduction: number;
  businessPercent: number;
  unclassifiedTrips: number;
  reviewTrips: number;
  inferredTrips: number;
  ratesApplied: { note: string; from: string; to: string; businessCents: number }[];
  firstTripAt: string | null;
  lastTripAt: string | null;
};

const CATEGORY_KEYS: Classification[] = [
  'business',
  'personal',
  'commute',
  'medical',
  'charity',
  'unclassified',
];

export function summarize(
  trips: Trip[],
  options: { timezone: string; rates: RatePeriod[] },
): Summary {
  const { timezone, rates } = options;
  const byClassification = Object.fromEntries(
    CATEGORY_KEYS.map((key) => [key, emptyTotals()]),
  ) as Record<Classification, Totals>;

  const months = new Map<string, MonthRow>();
  const clients = new Map<string, NamedRow>();
  const destinations = new Map<string, NamedRow>();
  const ratesApplied = new Map<string, { note: string; from: string; to: string; businessCents: number }>();

  let totalMiles = 0;
  let deductionCents = 0;
  let unclassifiedTrips = 0;
  let reviewTrips = 0;
  let inferredTrips = 0;
  let firstTripAt: string | null = null;
  let lastTripAt: string | null = null;

  for (const trip of trips) {
    const date = localDate(trip.startedAt, timezone);
    const { cents, period } = rateCents(date, trip.classification, rates);
    // Whole cents, so the sums below are exact.
    const tripDeductionCents = Math.round(trip.distanceMiles * cents);

    const bucket = byClassification[trip.classification] ?? emptyTotals();
    add(bucket, trip.distanceMiles, tripDeductionCents);
    byClassification[trip.classification] = bucket;

    totalMiles += trip.distanceMiles;
    deductionCents += tripDeductionCents;
    if (trip.classification === 'unclassified') unclassifiedTrips += 1;
    if (trip.needsReview) reviewTrips += 1;
    if (trip.inferred) inferredTrips += 1;
    if (firstTripAt === null || trip.startedAt < firstTripAt) firstTripAt = trip.startedAt;
    if (lastTripAt === null || trip.startedAt > lastTripAt) lastTripAt = trip.startedAt;

    const monthKey = localMonth(trip.startedAt, timezone);
    const row =
      months.get(monthKey) ??
      {
        month: monthKey,
        label: monthLabel(monthKey, timezone),
        business: emptyTotals(),
        personal: emptyTotals(),
        commute: emptyTotals(),
        other: emptyTotals(),
        unclassified: emptyTotals(),
        totalMiles: 0,
      };
    const target =
      trip.classification === 'business'
        ? row.business
        : trip.classification === 'personal'
          ? row.personal
          : trip.classification === 'commute'
            ? row.commute
            : trip.classification === 'unclassified'
              ? row.unclassified
              : row.other;
    add(target, trip.distanceMiles, tripDeductionCents);
    row.totalMiles += trip.distanceMiles;
    months.set(monthKey, row);

    if (trip.classification === 'business') {
      const clientName = (trip.client ?? '').trim();
      if (clientName !== '') {
        const entry = clients.get(clientName) ?? { name: clientName, trips: 0, miles: 0, deduction: 0 };
        entry.trips += 1;
        entry.miles += trip.distanceMiles;
        entry.deduction += tripDeductionCents;
        clients.set(clientName, entry);
      }

      const destination = (trip.endDescription ?? '').trim();
      if (destination !== '') {
        const entry =
          destinations.get(destination) ?? { name: destination, trips: 0, miles: 0, deduction: 0 };
        entry.trips += 1;
        entry.miles += trip.distanceMiles;
        entry.deduction += tripDeductionCents;
        destinations.set(destination, entry);
      }

      if (period !== null) {
        ratesApplied.set(period.from, {
          note: period.note,
          from: period.from,
          to: period.to,
          businessCents: period.business,
        });
      }
    }
  }

  // Round everything now that the sums are complete.
  for (const totals of Object.values(byClassification)) finalize(totals);
  for (const row of months.values()) {
    finalize(row.business);
    finalize(row.personal);
    finalize(row.commute);
    finalize(row.other);
    finalize(row.unclassified);
    row.totalMiles = round(row.totalMiles);
  }
  for (const entry of [...clients.values(), ...destinations.values()]) {
    entry.miles = round(entry.miles);
    entry.deduction = round2(entry.deduction / 100);
  }
  totalMiles = round(totalMiles);
  const deduction = round2(deductionCents / 100);

  const businessMiles = byClassification.business?.miles ?? 0;

  return {
    timezone,
    from: null,
    to: null,
    totalTrips: trips.length,
    totalMiles,
    byClassification,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    clients: [...clients.values()].sort((a, b) => b.miles - a.miles),
    destinations: [...destinations.values()].sort((a, b) => b.miles - a.miles),
    deduction,
    businessPercent: totalMiles === 0 ? 0 : Math.round((businessMiles / totalMiles) * 1000) / 10,
    unclassifiedTrips,
    reviewTrips,
    inferredTrips,
    ratesApplied: [...ratesApplied.values()].sort((a, b) => a.from.localeCompare(b.from)),
    firstTripAt,
    lastTripAt,
  };
}
