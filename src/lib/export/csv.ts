import { toCsv } from '../csv'
import { formatCalendarDate, calendarDateInZone, formatClockInZone } from '../time'
import type { ScheduleRow } from '../schedule/read'

/**
 * CSV renderings of a schedule, a roster and an officiating list.
 *
 * Pure functions over rows the caller has already read and authorized, so the same
 * output can be tested without a request and reused by anything that needs it.
 *
 * Every export carries both the local reading and the UTC instant. The local date and
 * time are what a human pastes into a newsletter; the ISO instant is what another
 * system can import without having to guess a zone. Emitting only one of the two makes
 * the file either unreadable or ambiguous.
 */

export const SCHEDULE_COLUMNS = [
  'date',
  'time',
  'timezone',
  'start_utc',
  'duration_minutes',
  'division',
  'round',
  'home_team',
  'away_team',
  'venue',
  'field',
  'status',
  'home_score',
  'away_score',
  'officials',
  'notes',
] as const

export function scheduleToCsv(rows: ScheduleRow[]): string {
  return toCsv(
    [...SCHEDULE_COLUMNS],
    rows.map((row) => [
      formatCalendarDate(calendarDateInZone(row.startTime, row.timezone)),
      formatClockInZone(row.startTime, row.timezone),
      row.timezone,
      row.startTime.toISOString(),
      row.durationMinutes,
      row.divisionName,
      row.roundNumber,
      row.homeTeamName,
      row.awayTeamName,
      row.venueName,
      row.fieldName,
      row.status,
      row.homeScore,
      row.awayScore,
      // Semicolons, because a comma here would need quoting in every single row.
      row.officials.map((official) => `${official.refereeName} (${official.position})`).join('; '),
      row.notes,
    ]),
  )
}

export const ROSTER_EXPORT_COLUMNS = [
  'name',
  'email',
  'phone',
  'role',
  'jersey',
  'dob',
  'notes',
] as const

export type RosterExportRow = {
  name: string
  email: string | null
  phone: string | null
  role: string
  jerseyNumber: string | null
  dob: Date | null
  notes: string | null
}

/** Deliberately the same columns the importer reads, so an export round-trips. */
export function rosterToCsv(rows: RosterExportRow[]): string {
  return toCsv(
    [...ROSTER_EXPORT_COLUMNS],
    rows.map((row) => [
      row.name,
      row.email,
      row.phone,
      row.role,
      row.jerseyNumber,
      row.dob ? formatCalendarDate(row.dob) : null,
      row.notes,
    ]),
  )
}

export const ASSIGNMENT_COLUMNS = [
  'official',
  'position',
  'response',
  'date',
  'time',
  'timezone',
  'start_utc',
  'division',
  'home_team',
  'away_team',
  'venue',
  'field',
] as const

/** One line per official per game, which is what a payments or availability run needs. */
export function assignmentsToCsv(rows: ScheduleRow[]): string {
  const lines = rows.flatMap((row) =>
    row.officials.map((official) => [
      official.refereeName,
      official.position,
      official.status,
      formatCalendarDate(calendarDateInZone(row.startTime, row.timezone)),
      formatClockInZone(row.startTime, row.timezone),
      row.timezone,
      row.startTime.toISOString(),
      row.divisionName,
      row.homeTeamName,
      row.awayTeamName,
      row.venueName,
      row.fieldName,
    ]),
  )
  return toCsv([...ASSIGNMENT_COLUMNS], lines)
}

/** Content-Disposition value with a filename safe for every browser. */
export function attachment(filename: string): string {
  const safe = filename.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return `attachment; filename="${safe}"`
}

export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': attachment(filename),
      // An export is a point-in-time read; caching one would hand back a stale roster.
      'cache-control': 'no-store',
    },
  })
}
