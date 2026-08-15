/**
 * Time handling for the whole app.
 *
 * Two kinds of value exist and they must not be confused:
 *
 *  1. **Instants** — a game kickoff. Stored as `timestamptz` holding UTC.
 *     Rendered in the venue's zone.
 *  2. **Local wall-clock rules** — "Field 2, Saturdays 8am-6pm, Mar 1 - Jun 15".
 *     Stored as day-of-week + minutes-from-midnight + a calendar date range.
 *     Converting one of these to an instant requires a zone and a date, and the
 *     result shifts across a DST boundary. That is the point: 8am stays 8am.
 *
 * Everything here is dependency-free, using `Intl` for zone arithmetic.
 */

export const MINUTES_PER_DAY = 24 * 60

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

/**
 * Parses `YYYY-MM-DD` into the UTC midnight of that day, which is how Postgres
 * `date` columns round-trip through Prisma. No zone is involved: a season that
 * starts March 1 starts March 1 everywhere.
 */
export function parseCalendarDate(input: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) throw new Error(`Expected a YYYY-MM-DD date, got "${input}".`)
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw new Error(`"${input}" is not a real date.`)
  }
  return date
}

export function formatCalendarDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

/** Inclusive list of calendar dates from `from` to `to`. */
export function eachCalendarDate(from: Date, to: Date): Date[] {
  const out: Date[] = []
  const cursor = new Date(from.getTime())
  while (cursor.getTime() <= to.getTime()) {
    out.push(new Date(cursor.getTime()))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/** Day of week of a calendar date, 0 = Sunday. Reads UTC fields deliberately. */
export function calendarDayOfWeek(date: Date): number {
  return date.getUTCDay()
}

export function addCalendarDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/** Whole days between two calendar dates. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

// ---------------------------------------------------------------------------
// Minutes from midnight
// ---------------------------------------------------------------------------

/** Parses `HH:MM` (24-hour) into minutes from midnight. */
export function parseTimeOfDay(input: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim())
  if (!match) throw new Error(`Expected an HH:MM time, got "${input}".`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) throw new Error(`"${input}" is not a real time.`)
  return hours * 60 + minutes
}

export function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Zone conversion
// ---------------------------------------------------------------------------

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, cached)
  }
  return cached
}

/** The wall-clock reading an observer in `timeZone` sees at instant `date`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // h23 renders midnight as 24 in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/** Offset of `timeZone` from UTC, in minutes, at instant `date`. Positive = east. */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asIfUtc - date.getTime()) / 60_000)
}

/**
 * Turns a local wall-clock reading into the UTC instant it denotes.
 *
 * Works by finding an offset that is self-consistent: subtract a candidate offset
 * from the naive timestamp, then confirm the zone really is at that offset at the
 * resulting instant. A single pass lands an hour off around DST transitions.
 *
 * The two awkward cases both resolve deterministically, matching the convention
 * Temporal calls "compatible":
 *
 *  - **Ambiguous** (the hour repeated when clocks go back): the first occurrence,
 *    i.e. the pre-transition offset. The first pass already agrees with itself
 *    there, so it returns early.
 *  - **Nonexistent** (the hour skipped when clocks go forward): shifts forward
 *    past the gap. Neither offset is self-consistent in that window, so the later
 *    of the two candidates is taken — 2:30am on a spring-forward day becomes
 *    3:30am rather than silently sliding back to 1:30am.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const hour = Math.floor(minutesFromMidnight / 60)
  const minute = minutesFromMidnight % 60
  const naive = Date.UTC(year, month - 1, day, hour, minute)

  const firstOffset = zoneOffsetMinutes(new Date(naive), timeZone)
  const firstCandidate = naive - firstOffset * 60_000

  const secondOffset = zoneOffsetMinutes(new Date(firstCandidate), timeZone)
  if (secondOffset === firstOffset) return new Date(firstCandidate)

  const secondCandidate = naive - secondOffset * 60_000
  if (zoneOffsetMinutes(new Date(secondCandidate), timeZone) === secondOffset) {
    return new Date(secondCandidate)
  }

  // Neither offset holds at its own candidate: the reading falls in a DST gap.
  return new Date(Math.max(firstCandidate, secondCandidate))
}

/** Combines a calendar date and a local minute-of-day into a UTC instant. */
export function slotInstant(calendarDate: Date, minutesFromMidnight: number, timeZone: string): Date {
  return zonedTimeToUtc(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth() + 1,
    calendarDate.getUTCDate(),
    minutesFromMidnight,
    timeZone,
  )
}

/** Minutes from local midnight that `instant` reads as in `timeZone`. */
export function minutesFromMidnightInZone(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  return p.hour * 60 + p.minute
}

/** The local calendar date `instant` falls on in `timeZone`, as UTC midnight. */
export function calendarDateInZone(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone)
  return new Date(Date.UTC(p.year, p.month - 1, p.day))
}

/** Local day of week (0 = Sunday) that `instant` falls on in `timeZone`. */
export function dayOfWeekInZone(instant: Date, timeZone: string): number {
  return calendarDateInZone(instant, timeZone).getUTCDay()
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** e.g. "Sat, Apr 11, 2026, 8:00 AM PDT" — always in the venue's zone. */
export function formatInstantInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant)
}

/** e.g. "8:00 AM" — in the venue's zone, no date. */
export function formatClockInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant)
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
