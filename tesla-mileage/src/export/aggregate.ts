/**
 * Totals without loading every trip.
 *
 * The exports need each trip anyway — a mileage log is a list of drives — but a
 * page that only shows four numbers should not read five years of rows to get
 * them. This computes the same figures with indexed SQL aggregates.
 *
 * The subtlety is that the deduction depends on the IRS rate in force on each
 * trip's *local* date, and rates change mid-year. So rather than one query, the
 * window is cut at every boundary that could change the answer — the start of
 * each local month and the edge of each rate period — and each segment is summed
 * on its own. A segment can then be attributed to exactly one month and exactly
 * one rate, which keeps the arithmetic identical to the per-trip path. There is a
 * test that holds the two implementations against each other.
 */
import type { Database } from '../db/index.ts';
import { tripWhere, type TripFilter } from '../db/repo.ts';
import type { Classification } from '../domain/types.ts';
import { CLASSIFICATIONS } from '../domain/types.ts';
import { periodFor, type RatePeriod } from '../domain/rates.ts';
import { localDate, localMonth, monthLabel, startOfLocalDay } from '../lib/time.ts';
import type { MonthRow, Summary, Totals } from './summary.ts';

function emptyTotals(): Totals {
  return { trips: 0, miles: 0, deduction: 0 };
}

function blankCategories(): Record<Classification, Totals> {
  return Object.fromEntries(CLASSIFICATIONS.map((key) => [key, emptyTotals()])) as Record<
    Classification,
    Totals
  >;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One aggregate query: miles and trip counts per category in a window. */
function segmentTotals(
  db: Database,
  from: string,
  to: string,
  filter: TripFilter,
  cents: { business: number; medical: number; charity: number },
): {
  classification: Classification;
  trips: number;
  miles: number;
  review: number;
  deductionCents: number;
}[] {
  // The segment window replaces any date range on the filter; everything else —
  // category, search, place, vehicle — comes from the shared builder, so the
  // aggregate and the row query always agree about what a filter means.
  const { sql: where, params: whereParams } = tripWhere(
    { ...filter, from: undefined, to: undefined },
    '',
  );
  const clauses = [where, 'started_at >= ?', 'started_at < ?'];
  const params: (string | number | null)[] = [...whereParams, from, to];

  // Whole cents per trip, summed as integers. That is what the per-trip path
  // does, and integers cannot disagree about a half cent.
  return db
    .all<{
      classification: string;
      trips: number;
      miles: number | null;
      review: number | null;
      deduction_cents: number | null;
    }>(
      `SELECT classification,
              COUNT(*)                          AS trips,
              COALESCE(SUM(distance_miles), 0)  AS miles,
              COALESCE(SUM(needs_review), 0)    AS review,
              COALESCE(SUM(CAST(ROUND(distance_miles * CASE classification
                    WHEN 'business' THEN ?
                    WHEN 'medical'  THEN ?
                    WHEN 'charity'  THEN ?
                    ELSE 0 END) AS INTEGER)), 0) AS deduction_cents
         FROM trip
        WHERE ${clauses.join(' AND ')}
        GROUP BY classification`,
      cents.business,
      cents.medical,
      cents.charity,
      ...params,
    )
    .map((row) => ({
      classification: row.classification as Classification,
      trips: Number(row.trips),
      miles: Number(row.miles ?? 0),
      review: Number(row.review ?? 0),
      deductionCents: Number(row.deduction_cents ?? 0),
    }));
}

/** Every instant where the month or the applicable rate could change. */
function boundaries(from: string, to: string, timezone: string, rates: RatePeriod[]): string[] {
  const points = new Set<string>([from, to]);

  // The first of each local month inside the window.
  let cursor = localMonth(from, timezone);
  for (let guard = 0; guard < 1200; guard += 1) {
    const [year, month] = cursor.split('-').map(Number);
    const y = year ?? 1970;
    const m = month ?? 1;
    const startIso = startOfLocalDay(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`, timezone);
    if (startIso >= to) break;
    if (startIso > from) points.add(startIso);
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  // The edges of each rate period.
  for (const rate of rates) {
    for (const edge of [rate.from, rate.to]) {
      // A period's `to` is inclusive, so the boundary is the following midnight.
      const iso =
        edge === rate.to
          ? startOfLocalDay(nextDay(edge), timezone)
          : startOfLocalDay(edge, timezone);
      if (iso > from && iso < to) points.add(iso);
    }
  }

  return [...points].sort();
}

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export type AggregateOptions = {
  timezone: string;
  rates: RatePeriod[];
  from?: string;
  to?: string;
  filter?: TripFilter;
  /** Include the per-month breakdown, which the dashboard chart needs. */
  months?: boolean;
};

/**
 * The same numbers `summarize` produces, minus the per-client and per-destination
 * lists, computed from aggregates. Those two lists still need the rows, so the
 * exports keep using the per-trip path.
 */
export function aggregateSummary(db: Database, options: AggregateOptions): Summary {
  const { timezone, rates } = options;
  const filter = options.filter ?? {};

  const span = db.get<{ first: string | null; last: string | null }>(
    'SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM trip WHERE deleted_at IS NULL',
  );
  const first = span?.first ?? null;
  const last = span?.last ?? null;

  const from = options.from ?? first ?? '1970-01-01T00:00:00.000Z';
  // `to` is exclusive; nudge past the newest trip so it is included.
  const to = options.to ?? (last === null ? '1970-01-01T00:00:00.001Z' : `${last}1`);

  const byClassification = blankCategories();
  const months = new Map<string, MonthRow>();
  const ratesApplied = new Map<string, { note: string; from: string; to: string; businessCents: number }>();

  let totalTrips = 0;
  let totalMiles = 0;
  let deductionCents = 0;
  let reviewTrips = 0;

  if (from < to) {
    const points = boundaries(from, to, timezone, rates);
    for (let i = 0; i < points.length - 1; i += 1) {
      const segmentFrom = points[i];
      const segmentTo = points[i + 1];
      if (segmentFrom === undefined || segmentTo === undefined || segmentFrom >= segmentTo) continue;

      const dateInSegment = localDate(segmentFrom, timezone);
      const monthKey = localMonth(segmentFrom, timezone);
      const period = periodFor(dateInSegment, rates);

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

      const segmentCents = {
        business: period?.business ?? 0,
        medical: period?.medical ?? 0,
        charity: period?.charity ?? 0,
      };
      const entries = segmentTotals(db, segmentFrom, segmentTo, filter, segmentCents);

      for (const entry of entries) {
        const segmentCentsTotal = entry.deductionCents;

        const bucket = byClassification[entry.classification] ?? emptyTotals();
        bucket.trips += entry.trips;
        bucket.miles += entry.miles;
        bucket.deduction += segmentCentsTotal;
        byClassification[entry.classification] = bucket;

        totalTrips += entry.trips;
        totalMiles += entry.miles;
        deductionCents += segmentCentsTotal;
        reviewTrips += entry.review;

        const target =
          entry.classification === 'business'
            ? row.business
            : entry.classification === 'personal'
              ? row.personal
              : entry.classification === 'commute'
                ? row.commute
                : entry.classification === 'unclassified'
                  ? row.unclassified
                  : row.other;
        target.trips += entry.trips;
        target.miles += entry.miles;
        target.deduction += segmentCentsTotal;
        row.totalMiles += entry.miles;

        if (entry.classification === 'business' && period !== null && entry.miles > 0) {
          ratesApplied.set(period.from, {
            note: period.note,
            from: period.from,
            to: period.to,
            businessCents: period.business,
          });
        }
      }

      if (options.months !== false && entries.length > 0) months.set(monthKey, row);
    }
  }

  // Cents become dollars only now, exactly as the per-trip path does.
  for (const totals of Object.values(byClassification)) {
    totals.miles = round1(totals.miles);
    totals.deduction = round2(totals.deduction / 100);
  }
  for (const row of months.values()) {
    for (const totals of [row.business, row.personal, row.commute, row.other, row.unclassified]) {
      totals.miles = round1(totals.miles);
      totals.deduction = round2(totals.deduction / 100);
    }
    row.totalMiles = round1(row.totalMiles);
  }
  totalMiles = round1(totalMiles);
  const deduction = round2(deductionCents / 100);

  const businessMiles = byClassification.business?.miles ?? 0;

  return {
    timezone,
    from: options.from ?? null,
    to: options.to ?? null,
    totalTrips,
    totalMiles,
    byClassification,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    // These two need the rows themselves; the exports compute them.
    clients: [],
    destinations: [],
    deduction,
    businessPercent: totalMiles === 0 ? 0 : Math.round((businessMiles / totalMiles) * 1000) / 10,
    unclassifiedTrips: byClassification.unclassified?.trips ?? 0,
    reviewTrips,
    inferredTrips: 0,
    ratesApplied: [...ratesApplied.values()].sort((a, b) => a.from.localeCompare(b.from)),
    firstTripAt: first,
    lastTripAt: last,
  };
}
