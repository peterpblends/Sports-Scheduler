/**
 * Time helpers.
 *
 * Everything is stored as an ISO-8601 UTC string. A mileage log is a tax
 * document, so which calendar day a trip lands on has to be the driver's local
 * day, not UTC — every day/month/year bucket here goes through the configured
 * IANA time zone.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Is this a time zone Intl will accept?
 *
 * Every date in the app is rendered through the configured zone, so a bad value
 * would throw on every page — including the settings page needed to correct it.
 * Anything reaching Intl is checked here first.
 */
export function isValidTimezone(zone: string): boolean {
  if (zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function toIso(value: Date | number | string): string {
  if (typeof value === 'string') return new Date(value).toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return value.toISOString();
}

export function msOf(iso: string): number {
  return new Date(iso).getTime();
}

export function isValidIso(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

const partCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, options: Intl.DateTimeFormatOptions, tag: string): Intl.DateTimeFormat {
  const key = `${tz}|${tag}`;
  const existing = partCache.get(key);
  if (existing) return existing;
  const made = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options });
  partCache.set(key, made);
  return made;
}

export type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Break an instant into the wall-clock parts a driver in `tz` would have seen. */
export function partsInZone(iso: string, tz: string): DateParts {
  const dtf = formatter(
    tz,
    {
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    },
    'parts',
  );
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(iso))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  const weekdayIndex = WEEKDAYS.indexOf(out.weekday ?? 'Sun');
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `YYYY-MM-DD` in the given zone. */
export function localDate(iso: string, tz: string): string {
  const p = partsInZone(iso, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM` in the given zone. */
export function localMonth(iso: string, tz: string): string {
  const p = partsInZone(iso, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}`;
}

export function localYear(iso: string, tz: string): number {
  return partsInZone(iso, tz).year;
}

/** Minutes since local midnight — the unit rules use for time-of-day windows. */
export function localMinutes(iso: string, tz: string): number {
  const p = partsInZone(iso, tz);
  return p.hour * 60 + p.minute;
}

export function localWeekday(iso: string, tz: string): number {
  return partsInZone(iso, tz).weekday;
}

/** `3:42 PM` */
export function localClock(iso: string, tz: string): string {
  const p = partsInZone(iso, tz);
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${hour12}:${pad(p.minute)} ${suffix}`;
}

/** `Mon Aug 17, 2026` */
export function localLongDate(iso: string, tz: string): string {
  return formatter(
    tz,
    { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
    'long',
  ).format(new Date(iso));
}

/** `Aug 17, 3:42 PM` */
export function localShort(iso: string, tz: string): string {
  const p = partsInZone(iso, tz);
  const month = formatter(tz, { month: 'short' }, 'mon').format(new Date(iso));
  return `${month} ${p.day}, ${localClock(iso, tz)}`;
}

/** Offset of `tz` from UTC, in ms, at the given instant. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const p = partsInZone(new Date(utcMs).toISOString(), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

/**
 * Turn a wall-clock time in `tz` into a UTC instant. Runs the offset lookup
 * twice so a boundary that lands inside a DST transition resolves correctly.
 */
export function zonedToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): string {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstPass = guess - zoneOffsetMs(guess, tz);
  const settled = guess - zoneOffsetMs(firstPass, tz);
  return new Date(settled).toISOString();
}

/** Start of a local calendar day (`YYYY-MM-DD`) as a UTC instant. */
export function startOfLocalDay(dateStr: string, tz: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return zonedToUtcIso(y ?? 1970, m ?? 1, d ?? 1, 0, 0, 0, tz);
}

/** Exclusive end of a local calendar day. */
export function endOfLocalDay(dateStr: string, tz: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1));
  return startOfLocalDay(
    `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`,
    tz,
  );
}

/** Inclusive-start / exclusive-end UTC window covering a local tax year. */
export function localYearRange(year: number, tz: string): { from: string; to: string } {
  return {
    from: zonedToUtcIso(year, 1, 1, 0, 0, 0, tz),
    to: zonedToUtcIso(year + 1, 1, 1, 0, 0, 0, tz),
  };
}

export function localMonthRange(month: string, tz: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const year = y ?? 1970;
  const mon = m ?? 1;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  return {
    from: zonedToUtcIso(year, mon, 1, 0, 0, 0, tz),
    to: zonedToUtcIso(nextYear, nextMon, 1, 0, 0, 0, tz),
  };
}

/** `1h 24m`, `18m`, `45s` */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

/** "2 minutes ago" style label for the live status strip. */
export function humanAgo(iso: string, from = Date.now()): string {
  const diff = Math.max(0, from - msOf(iso));
  const seconds = Math.round(diff / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function monthLabel(month: string, tz: string): string {
  const { from } = localMonthRange(month, tz);
  return formatter(tz, { month: 'long', year: 'numeric' }, 'monthlabel').format(new Date(from));
}
