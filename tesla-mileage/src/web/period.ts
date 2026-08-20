/** Shared period picker used by the trip list, the dashboard and every export. */
import { localMonth, localMonthRange, localYear, localYearRange, monthLabel, nowIso, startOfLocalDay, endOfLocalDay } from '../lib/time.ts';

export type Period = {
  key: string;
  label: string;
  from?: string;
  to?: string;
  fileTag: string;
  /** The local dates as typed, so a custom range round-trips through links. */
  rawFrom?: string;
  rawTo?: string;
};

export const PERIOD_CHOICES = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'ytd', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
  { key: 'all', label: 'All time' },
];

function previousMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const y = year ?? 1970;
  const m = mon ?? 1;
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Resolve a period from query parameters. `from`/`to` are local calendar dates
 * and win over `period` when both are present.
 */
export function resolvePeriod(
  params: { period?: string | null; from?: string | null; to?: string | null },
  timezone: string,
): Period {
  const from = (params.from ?? '').trim();
  const to = (params.to ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) || /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(from) ? startOfLocalDay(from, timezone) : undefined;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? endOfLocalDay(to, timezone) : undefined;
    return {
      key: 'custom',
      label: `${from === '' ? 'the beginning' : from} to ${to === '' ? 'now' : to}`,
      from: start,
      to: end,
      fileTag: `${from === '' ? 'start' : from}_${to === '' ? 'now' : to}`,
      rawFrom: from === '' ? undefined : from,
      rawTo: to === '' ? undefined : to,
    };
  }

  const now = nowIso();
  const key = params.period ?? 'this-month';

  if (key === 'all') return { key, label: 'All time', fileTag: 'all-time' };

  if (key === 'ytd') {
    const year = localYear(now, timezone);
    const range = localYearRange(year, timezone);
    return { key, label: `${year}`, from: range.from, to: range.to, fileTag: `${year}` };
  }

  if (key === 'last-year') {
    const year = localYear(now, timezone) - 1;
    const range = localYearRange(year, timezone);
    return { key, label: `${year}`, from: range.from, to: range.to, fileTag: `${year}` };
  }

  if (key === 'last-month') {
    const month = previousMonth(localMonth(now, timezone));
    const range = localMonthRange(month, timezone);
    return { key, label: monthLabel(month, timezone), from: range.from, to: range.to, fileTag: month };
  }

  const month = localMonth(now, timezone);
  const range = localMonthRange(month, timezone);
  return { key: 'this-month', label: monthLabel(month, timezone), from: range.from, to: range.to, fileTag: month };
}

export function periodQuery(period: Period): string {
  if (period.key === 'custom') {
    const params = new URLSearchParams();
    if (period.rawFrom !== undefined) params.set('from', period.rawFrom);
    if (period.rawTo !== undefined) params.set('to', period.rawTo);
    return params.toString();
  }
  return `period=${encodeURIComponent(period.key)}`;
}
