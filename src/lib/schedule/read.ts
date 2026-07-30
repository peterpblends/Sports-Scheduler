import { prisma } from '../prisma'
import { parseSnapshot, type GameSnapshot } from '../versions/snapshot'
import { calendarDateInZone, formatCalendarDate } from '../time'

/**
 * The one place a schedule is read for display.
 *
 * Every view in the app — list, calendar, per-team, per-venue, per-referee, and the
 * public page — goes through here, so the published/draft split is decided once
 * rather than re-derived per page. A role that holds `schedule:read` sees the live
 * working set; everyone else is served the frozen published snapshot, which is what
 * stops an in-progress draft edit from leaking (non-negotiable, phase 4).
 *
 * Both sources are normalised to the same `ScheduleRow`, so a view never has to know
 * which one it got. Filtering happens after normalisation for the same reason: a
 * snapshot cannot be filtered with a SQL `where`.
 */

export type ScheduleOfficial = {
  /** Row id for a live game; a synthetic `gameId:index` for a snapshot. */
  id: string
  refereeId: string
  refereeName: string
  position: string
  status: string
}

export type ScheduleRow = {
  id: string
  seasonId: string
  divisionId: string
  divisionName: string
  homeTeamId: string
  homeTeamName: string
  awayTeamId: string
  awayTeamName: string
  fieldId: string | null
  fieldName: string | null
  venueId: string | null
  venueName: string | null
  /** The venue's zone, or the org's when a game is not yet placed. */
  timezone: string
  startTime: Date
  durationMinutes: number
  status: string
  homeScore: number | null
  awayScore: number | null
  roundNumber: number | null
  notes: string | null
  officials: ScheduleOfficial[]
}

export type ScheduleFilter = {
  divisionId?: string | null
  teamId?: string | null
  venueId?: string | null
  fieldId?: string | null
  refereeId?: string | null
}

export type ScheduleRead = {
  source: 'live' | 'published' | 'none'
  version: { id: string; number: number; label: string; publishedAt: Date | null } | null
  rows: ScheduleRow[]
  /** Rows before filtering, so a view can say "12 of 128". */
  totalBeforeFilter: number
  /** Fallback zone for anything unplaced. */
  orgTimezone: string
  /** True when the caller is looking at the editable working set. */
  editable: boolean
}

export async function readSchedule(input: {
  orgId: string
  seasonId: string
  canReadDrafts: boolean
  filter?: ScheduleFilter
}): Promise<ScheduleRead> {
  const { orgId, seasonId, canReadDrafts, filter = {} } = input

  const [org, season] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } }),
    prisma.season.findUnique({
      where: { id: seasonId },
      select: {
        publishedVersion: {
          select: { id: true, number: true, label: true, publishedAt: true, snapshot: true },
        },
      },
    }),
  ])

  const published = season?.publishedVersion ?? null
  const version = published
    ? {
        id: published.id,
        number: published.number,
        label: published.label,
        publishedAt: published.publishedAt,
      }
    : null

  // A draft reader gets live rows and is told separately what is published, so the UI
  // can warn that the two differ. Everyone else only ever sees the snapshot.
  const rows = canReadDrafts
    ? await liveRows(seasonId, org.timezone)
    : snapshotRows(published ? parseSnapshot(published.snapshot).games : [], org.timezone)

  return {
    source: canReadDrafts ? 'live' : published ? 'published' : 'none',
    version,
    rows: applyFilter(rows, filter),
    totalBeforeFilter: rows.length,
    orgTimezone: org.timezone,
    editable: canReadDrafts,
  }
}

async function liveRows(seasonId: string, orgTimezone: string): Promise<ScheduleRow[]> {
  const games = await prisma.game.findMany({
    where: { seasonId, deletedAt: null },
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    include: {
      homeTeam: { select: { id: true, name: true } },
      awayTeam: { select: { id: true, name: true } },
      division: { select: { id: true, name: true } },
      field: { include: { venue: { select: { id: true, name: true, timezone: true } } } },
      officials: {
        where: { deletedAt: null },
        orderBy: { position: 'asc' },
        include: { referee: { include: { person: { select: { id: true, name: true } } } } },
      },
    },
  })

  return games.map((game) => ({
    id: game.id,
    seasonId: game.seasonId,
    divisionId: game.divisionId,
    divisionName: game.division.name,
    homeTeamId: game.homeTeamId,
    homeTeamName: game.homeTeam.name,
    awayTeamId: game.awayTeamId,
    awayTeamName: game.awayTeam.name,
    fieldId: game.fieldId,
    fieldName: game.field?.name ?? null,
    venueId: game.field?.venue.id ?? null,
    venueName: game.field?.venue.name ?? null,
    timezone: game.field?.venue.timezone ?? orgTimezone,
    startTime: game.startTime,
    durationMinutes: game.durationMinutes,
    status: game.status,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    roundNumber: game.roundNumber,
    notes: game.notes,
    officials: game.officials.map((official) => ({
      id: official.id,
      refereeId: official.refereeId,
      refereeName: official.referee.person.name,
      position: official.position,
      status: official.status,
    })),
  }))
}

function snapshotRows(games: GameSnapshot[], orgTimezone: string): ScheduleRow[] {
  return games
    .map((game) => ({
      id: game.gameId,
      seasonId: '',
      divisionId: game.divisionId,
      divisionName: game.divisionName,
      homeTeamId: game.homeTeamId,
      homeTeamName: game.homeTeamName,
      awayTeamId: game.awayTeamId,
      awayTeamName: game.awayTeamName,
      fieldId: game.fieldId,
      fieldName: game.fieldName,
      venueId: game.venueId,
      venueName: game.venueName,
      timezone: game.timezone ?? orgTimezone,
      startTime: new Date(game.startTime),
      durationMinutes: game.durationMinutes,
      status: game.status,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      roundNumber: game.roundNumber,
      notes: game.notes,
      officials: game.officials.map((official, index) => ({
        id: `${game.gameId}:${index}`,
        refereeId: official.refereeId,
        refereeName: official.refereeName,
        position: official.position,
        status: official.status,
      })),
    }))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id))
}

function applyFilter(rows: ScheduleRow[], filter: ScheduleFilter): ScheduleRow[] {
  return rows.filter((row) => {
    if (filter.divisionId && row.divisionId !== filter.divisionId) return false
    if (filter.teamId && row.homeTeamId !== filter.teamId && row.awayTeamId !== filter.teamId) {
      return false
    }
    if (filter.venueId && row.venueId !== filter.venueId) return false
    if (filter.fieldId && row.fieldId !== filter.fieldId) return false
    if (filter.refereeId && !row.officials.some((o) => o.refereeId === filter.refereeId)) {
      return false
    }
    return true
  })
}

/**
 * Groups rows by the date they fall on *in the venue's zone*.
 *
 * An 8pm Pacific Saturday game is already Sunday in UTC, so grouping on the UTC date
 * files it under the wrong day. Keys are `YYYY-MM-DD` and sort correctly as strings.
 */
export function groupByLocalDate(rows: ScheduleRow[]): Array<{ date: string; rows: ScheduleRow[] }> {
  const buckets = new Map<string, ScheduleRow[]>()
  for (const row of rows) {
    const key = formatCalendarDate(calendarDateInZone(row.startTime, row.timezone))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => ({ date, rows: dayRows }))
}

/** A row is short one or more officials when the season's crew size is not met. */
export function unfilledPositions(row: ScheduleRow, crewSize: number): number {
  const accepted = row.officials.filter((o) => o.status !== 'declined').length
  return Math.max(0, crewSize - accepted)
}
