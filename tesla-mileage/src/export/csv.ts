/**
 * CSV exports.
 *
 * The detail export is the one that matters: it is the mileage log itself, with
 * the four things the IRS asks a taxpayer to be able to show for each trip —
 * the date, the miles, where the car went, and the business purpose — plus the
 * odometer readings and a plain-English note on how each trip was categorized,
 * so any row can be audited without opening the app.
 */
import type { Trip } from '../domain/types.ts';
import type { RatePeriod } from '../domain/rates.ts';
import { rateCents } from '../domain/rates.ts';
import { localClock, localDate, localLongDate } from '../lib/time.ts';
import type { Summary } from './summary.ts';

function escape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function line(cells: (string | number | null | undefined)[]): string {
  return cells.map(escape).join(',');
}

export const TRIP_COLUMNS = [
  'Date',
  'Day',
  'Start time',
  'End time',
  'From',
  'To',
  'Miles',
  'Category',
  'Business purpose',
  'Client / project',
  'Start odometer',
  'End odometer',
  'Rate (cents/mile)',
  'Deduction (USD)',
  'Duration (min)',
  'Decided by',
  'Why',
  'Notes',
  'Reconstructed',
];

export function tripsCsv(
  trips: Trip[],
  options: { timezone: string; rates: RatePeriod[] },
): string {
  const rows = [line(TRIP_COLUMNS)];
  for (const trip of trips) {
    const date = localDate(trip.startedAt, options.timezone);
    const { cents } = rateCents(date, trip.classification, options.rates);
    const deduction = Math.round(trip.distanceMiles * cents) / 100;
    rows.push(
      line([
        date,
        localLongDate(trip.startedAt, options.timezone).slice(0, 3),
        localClock(trip.startedAt, options.timezone),
        localClock(trip.endedAt, options.timezone),
        trip.startDescription,
        trip.endDescription,
        trip.distanceMiles.toFixed(1),
        trip.classification,
        trip.purpose,
        trip.client,
        trip.startOdometerMiles === null ? '' : trip.startOdometerMiles.toFixed(1),
        trip.endOdometerMiles === null ? '' : trip.endOdometerMiles.toFixed(1),
        cents === 0 ? '' : cents.toFixed(1),
        deduction === 0 ? '' : deduction.toFixed(2),
        Math.round(trip.durationSeconds / 60),
        trip.classificationSource,
        trip.classificationReason,
        trip.notes,
        trip.inferred ? 'yes' : '',
      ]),
    );
  }
  return `${rows.join('\n')}\n`;
}

/** Month-by-month totals, the shape most tax preparers ask for. */
export function summaryCsv(summary: Summary): string {
  const rows: string[] = [];
  rows.push(line(['Mileage summary']));
  rows.push(line(['Time zone', summary.timezone]));
  rows.push(line(['Trips', summary.totalTrips]));
  rows.push(line(['Total miles', summary.totalMiles.toFixed(1)]));
  rows.push(line(['Business miles', (summary.byClassification.business?.miles ?? 0).toFixed(1)]));
  rows.push(line(['Business share of miles', `${summary.businessPercent}%`]));
  rows.push(line(['Estimated deduction (USD)', summary.deduction.toFixed(2)]));
  rows.push('');

  rows.push(line(['Month', 'Business miles', 'Personal miles', 'Commute miles', 'Other miles', 'Unclassified miles', 'Total miles', 'Business deduction (USD)']));
  for (const month of summary.months) {
    rows.push(
      line([
        month.label,
        month.business.miles.toFixed(1),
        month.personal.miles.toFixed(1),
        month.commute.miles.toFixed(1),
        month.other.miles.toFixed(1),
        month.unclassified.miles.toFixed(1),
        month.totalMiles.toFixed(1),
        month.business.deduction.toFixed(2),
      ]),
    );
  }

  if (summary.clients.length > 0) {
    rows.push('');
    rows.push(line(['Client / project', 'Trips', 'Business miles', 'Deduction (USD)']));
    for (const client of summary.clients) {
      rows.push(line([client.name, client.trips, client.miles.toFixed(1), client.deduction.toFixed(2)]));
    }
  }

  if (summary.destinations.length > 0) {
    rows.push('');
    rows.push(line(['Business destination', 'Trips', 'Miles', 'Deduction (USD)']));
    for (const destination of summary.destinations.slice(0, 50)) {
      rows.push(
        line([destination.name, destination.trips, destination.miles.toFixed(1), destination.deduction.toFixed(2)]),
      );
    }
  }

  if (summary.ratesApplied.length > 0) {
    rows.push('');
    rows.push(line(['Rate period from', 'to', 'Business cents/mile', 'Source']));
    for (const rate of summary.ratesApplied) {
      rows.push(line([rate.from, rate.to, rate.businessCents.toFixed(1), rate.note]));
    }
  }

  return `${rows.join('\n')}\n`;
}

/** Everything, as JSON, for a backup or another tool. */
export function backupJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
