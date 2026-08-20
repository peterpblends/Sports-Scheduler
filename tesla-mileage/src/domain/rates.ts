/**
 * IRS standard mileage rates.
 *
 * These are seeded into the database so they can be corrected without a code
 * change — the IRS has revised a rate mid-year more than once, and the CPA is
 * always the final authority. Every export prints the rate it used.
 */
import type { Classification } from './types.ts';

export type RatePeriod = {
  from: string; // inclusive local date, YYYY-MM-DD
  to: string; // inclusive local date
  business: number; // cents per mile
  medical: number;
  charity: number;
  note: string;
};

/** Published rates. Verify against irs.gov/tax-professionals/standard-mileage-rates. */
export const IRS_RATES: RatePeriod[] = [
  { from: '2022-01-01', to: '2022-06-30', business: 58.5, medical: 18, charity: 14, note: 'IRS Notice 2022-03' },
  { from: '2022-07-01', to: '2022-12-31', business: 62.5, medical: 22, charity: 14, note: 'IRS Announcement 2022-13 (mid-year increase)' },
  { from: '2023-01-01', to: '2023-12-31', business: 65.5, medical: 22, charity: 14, note: 'IRS Notice 2023-03' },
  { from: '2024-01-01', to: '2024-12-31', business: 67, medical: 21, charity: 14, note: 'IRS Notice 2024-08' },
  { from: '2025-01-01', to: '2025-12-31', business: 70, medical: 21, charity: 14, note: 'IRS Notice 2025-05' },
  { from: '2026-01-01', to: '2026-06-30', business: 72.5, medical: 20.5, charity: 14, note: 'IRS 2026 standard rates' },
  { from: '2026-07-01', to: '2026-12-31', business: 76, medical: 23.5, charity: 14, note: 'IRS mid-year 2026 increase' },
];

/**
 * The rate period covering a date.
 *
 * More than one period can contain a date once someone adds a correction — a
 * mid-year revision, say, layered over a full-year default. The later-starting
 * period wins, and a shorter one breaks a tie, so a correction always takes
 * precedence over the broader entry it was meant to fix.
 */
export function periodFor(localDate: string, periods: RatePeriod[] = IRS_RATES): RatePeriod | null {
  let best: RatePeriod | null = null;
  for (const candidate of periods) {
    if (localDate < candidate.from || localDate > candidate.to) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.from > best.from) {
      best = candidate;
      continue;
    }
    if (candidate.from === best.from && candidate.to < best.to) best = candidate;
  }
  return best;
}

/** Cents per mile for a classification on a given local date. */
export function rateCents(
  localDate: string,
  classification: Classification,
  periods: RatePeriod[] = IRS_RATES,
): { cents: number; period: RatePeriod | null } {
  const period = periodFor(localDate, periods);
  if (period === null) return { cents: 0, period: null };
  if (classification === 'business') return { cents: period.business, period };
  if (classification === 'medical') return { cents: period.medical, period };
  if (classification === 'charity') return { cents: period.charity, period };
  return { cents: 0, period };
}

/** Deduction in dollars for a distance on a date, rounded to the cent. */
export function deductionDollars(
  miles: number,
  localDate: string,
  classification: Classification,
  periods: RatePeriod[] = IRS_RATES,
): number {
  const { cents } = rateCents(localDate, classification, periods);
  return Math.round(miles * cents) / 100;
}

/** The latest date the built-in table covers — used to warn when it goes stale. */
export function ratesCoverThrough(periods: RatePeriod[] = IRS_RATES): string {
  return periods.reduce((latest, p) => (p.to > latest ? p.to : latest), '0000-00-00');
}
