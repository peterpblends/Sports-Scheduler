import { prisma } from './prisma'
import { readSchedule, type ScheduleRow } from './schedule/read'
import { loadRefereeBoard, type RefereeBoard } from './officiating'
import { staffTeams } from './scope'

/**
 * Per-role dashboard reads.
 *
 * A dashboard should answer "what needs me today", and that question has a
 * different answer for every role. Rather than one page of accumulating
 * conditionals, each role gets a loader that fetches exactly what its panels show.
 *
 * Nothing here authorizes. Callers resolve the role and the actor first; these
 * functions take an already-verified `refereeId` or team list and only read.
 */

export type TeamForm = {
  teamId: string
  teamName: string
  divisionName: string
  played: number
  won: number
  drawn: number
  lost: number
  goalsFor: number
  goalsAgainst: number
  rosterSize: number
}

export type CoachDashboard = {
  teams: Array<{ id: string; name: string; divisionName: string }>
  /** The single most useful fact on the page: the next fixture. */
  next: ScheduleRow | null
  upcoming: ScheduleRow[]
  recent: ScheduleRow[]
  form: TeamForm[]
  source: 'live' | 'published' | 'none'
}

export type ViewerDashboard = {
  next: ScheduleRow | null
  upcoming: ScheduleRow[]
  recent: ScheduleRow[]
  divisions: Array<{ id: string; name: string; teamCount: number }>
  published: { number: number; publishedAt: Date | null } | null
  source: 'live' | 'published' | 'none'
  totalGames: number
}

/** A game a team was actually in, with a result worth reporting. */
function isFinished(row: ScheduleRow): boolean {
  return row.status === 'played' && row.homeScore !== null && row.awayScore !== null
}

export async function loadCoachDashboard(input: {
  orgId: string
  seasonId: string | null
  userId: string
  canReadDrafts: boolean
  now?: Date
}): Promise<CoachDashboard> {
  const { orgId, seasonId, userId, canReadDrafts, now = new Date() } = input

  const teams = await staffTeams(userId, orgId)
  if (!seasonId || teams.length === 0) {
    return { teams, next: null, upcoming: [], recent: [], form: [], source: 'none' }
  }

  const teamIds = new Set(teams.map((team) => team.id))
  const schedule = await readSchedule({ orgId, seasonId, canReadDrafts })

  const mine = schedule.rows.filter(
    (row) => teamIds.has(row.homeTeamId) || teamIds.has(row.awayTeamId),
  )

  const upcoming = mine
    .filter((row) => row.startTime.getTime() >= now.getTime() && row.status !== 'cancelled')
    .slice(0, 8)

  // Most recent first — a coach looking back wants the last result, not the first.
  // Filtered to games with a score actually recorded, the same as the viewer's. A
  // past fixture with no score is not a result, and listing it under that heading
  // reads as "we lost nil-nil".
  const recent = mine.filter(isFinished).slice().reverse().slice(0, 5)

  const rosterSizes = await prisma.teamMembership.groupBy({
    by: ['teamId'],
    where: { teamId: { in: [...teamIds] }, deletedAt: null, role: 'player' },
    _count: { _all: true },
  })
  const rosterByTeam = new Map(rosterSizes.map((row) => [row.teamId, row._count._all]))

  const form: TeamForm[] = teams.map((team) => {
    const played = mine.filter(
      (row) => isFinished(row) && (row.homeTeamId === team.id || row.awayTeamId === team.id),
    )
    let won = 0
    let drawn = 0
    let lost = 0
    let goalsFor = 0
    let goalsAgainst = 0

    for (const row of played) {
      const home = row.homeTeamId === team.id
      const scored = home ? row.homeScore! : row.awayScore!
      const conceded = home ? row.awayScore! : row.homeScore!
      goalsFor += scored
      goalsAgainst += conceded
      if (scored > conceded) won += 1
      else if (scored === conceded) drawn += 1
      else lost += 1
    }

    return {
      teamId: team.id,
      teamName: team.name,
      divisionName: team.divisionName,
      played: played.length,
      won,
      drawn,
      lost,
      goalsFor,
      goalsAgainst,
      rosterSize: rosterByTeam.get(team.id) ?? 0,
    }
  })

  return { teams, next: upcoming[0] ?? null, upcoming, recent, form, source: schedule.source }
}

export async function loadRefereeDashboard(input: {
  orgId: string
  seasonId: string | null
  refereeId: string
  canReadDrafts: boolean
}): Promise<RefereeBoard | null> {
  if (!input.seasonId) return null
  return loadRefereeBoard({
    orgId: input.orgId,
    seasonId: input.seasonId,
    refereeId: input.refereeId,
    canReadDrafts: input.canReadDrafts,
    // The dashboard only shows a count and the first few, so a shorter scan is
    // enough here; the full board page uses the default.
    openLimit: 20,
  })
}

export async function loadViewerDashboard(input: {
  orgId: string
  seasonId: string | null
  canReadDrafts: boolean
  now?: Date
}): Promise<ViewerDashboard> {
  const { orgId, seasonId, canReadDrafts, now = new Date() } = input

  if (!seasonId) {
    return {
      next: null,
      upcoming: [],
      recent: [],
      divisions: [],
      published: null,
      source: 'none',
      totalGames: 0,
    }
  }

  const [schedule, divisions] = await Promise.all([
    readSchedule({ orgId, seasonId, canReadDrafts }),
    prisma.division.findMany({
      where: { seasonId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, _count: { select: { teams: { where: { deletedAt: null } } } } },
    }),
  ])

  const upcoming = schedule.rows
    .filter((row) => row.startTime.getTime() >= now.getTime() && row.status !== 'cancelled')
    .slice(0, 8)

  const recent = schedule.rows
    .filter(isFinished)
    .slice()
    .reverse()
    .slice(0, 5)

  return {
    next: upcoming[0] ?? null,
    upcoming,
    recent,
    divisions: divisions.map((division) => ({
      id: division.id,
      name: division.name,
      teamCount: division._count.teams,
    })),
    published: schedule.version
      ? { number: schedule.version.number, publishedAt: schedule.version.publishedAt }
      : null,
    source: schedule.source,
    totalGames: schedule.totalBeforeFilter,
  }
}
