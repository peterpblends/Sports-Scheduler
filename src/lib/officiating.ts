import { prisma } from './prisma'
import { readSchedule, type ScheduleRow } from './schedule/read'
import {
  loadRefereeConflictContext,
  officialConflicts,
  teamPersonIdsForGames,
  type Conflict,
} from './conflicts'

/**
 * What a referee sees about their own officiating, in one read.
 *
 * The point of this module is that a referee's questions are not the same as an
 * assigner's. An assigner asks "which games are short an official"; a referee asks
 * "what have I got, what is waiting on me, what did I ask for, and what is going
 * spare". Those are five different slices of the same data, so they are computed
 * together rather than in five page-level queries that would each re-derive the
 * schedule.
 *
 * Everything is scoped to one referee id, which callers must resolve from the
 * session. Nothing here authorizes; it assumes the caller already did.
 */

export type OfficiatingAssignment = {
  /** The GameOfficial row id, which is what the accept/decline PATCH targets. */
  assignmentId: string
  position: string
  status: 'pending' | 'accepted' | 'declined'
  respondedAt: Date | null
  row: ScheduleRow
}

export type OfficiatingRequestView = {
  requestId: string
  position: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  note: string | null
  decisionNote: string | null
  decidedAt: Date | null
  createdAt: Date
  row: ScheduleRow | null
}

export type OpenGame = {
  row: ScheduleRow
  /** Positions with nobody holding them, after ignoring declines. */
  openPositions: string[]
  /**
   * Empty means the referee may request it. Non-empty means the request endpoint
   * would refuse, and the reason is shown rather than the game being hidden — a
   * referee who cannot see *why* they are ineligible will just ask a human.
   */
  conflicts: Conflict[]
}

export type RefereeBoard = {
  /** Assignments the referee has accepted: they are officiating these. */
  accepted: OfficiatingAssignment[]
  /** Offered to them and waiting on their answer. */
  awaitingAnswer: OfficiatingAssignment[]
  /** They declined these. Kept visible so a mistaken decline is recoverable. */
  declined: OfficiatingAssignment[]
  /** Their own requests, waiting on an assigner. */
  pendingRequests: OfficiatingRequestView[]
  /** Requests already answered, most recent first. */
  answeredRequests: OfficiatingRequestView[]
  /** Games short an official that the referee could take. */
  openGames: OpenGame[]
  /** Whether a schedule exists at all, so the UI can tell "none" from "empty". */
  source: 'live' | 'published' | 'none'
  orgTimezone: string
}

/** Positions a full crew is expected to have, in the order they are filled. */
export const CREW_POSITIONS = ['center', 'AR1', 'AR2'] as const

/**
 * The board for one referee across one season.
 *
 * `canReadDrafts` is passed through to `readSchedule` rather than assumed: a
 * referee sees the published snapshot, but an admin previewing the referee view
 * should see what they themselves are entitled to. Assignment *rows* always come
 * from live data, because accepting or declining acts on a live row — a snapshot
 * has no id to PATCH.
 */
export async function loadRefereeBoard(input: {
  orgId: string
  seasonId: string
  refereeId: string
  canReadDrafts: boolean
  now?: Date
  /** Cap on how many open games to evaluate. Keeps a long season bounded. */
  openLimit?: number
}): Promise<RefereeBoard> {
  const { orgId, seasonId, refereeId, canReadDrafts, now = new Date(), openLimit = 60 } = input

  const [schedule, assignments, requests] = await Promise.all([
    readSchedule({ orgId, seasonId, canReadDrafts }),
    prisma.gameOfficial.findMany({
      where: {
        refereeId,
        deletedAt: null,
        game: { deletedAt: null, seasonId, season: { league: { orgId } } },
      },
      orderBy: { game: { startTime: 'asc' } },
      select: {
        id: true,
        position: true,
        status: true,
        respondedAt: true,
        gameId: true,
      },
    }),
    prisma.officiatingRequest.findMany({
      where: {
        refereeId,
        deletedAt: null,
        game: { deletedAt: null, seasonId, season: { league: { orgId } } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        gameId: true,
        position: true,
        status: true,
        note: true,
        decisionNote: true,
        decidedAt: true,
        createdAt: true,
      },
    }),
  ])

  const rowsById = new Map(schedule.rows.map((row) => [row.id, row]))

  // An assignment whose game is not in the readable schedule is dropped rather
  // than rendered without a kickoff time. For a referee that means an assignment
  // on a game the current published version does not contain — which is exactly
  // the state where showing it would be misleading.
  const view = (assignment: (typeof assignments)[number]): OfficiatingAssignment | null => {
    const row = rowsById.get(assignment.gameId)
    if (!row) return null
    return {
      assignmentId: assignment.id,
      position: assignment.position,
      status: assignment.status,
      respondedAt: assignment.respondedAt,
      row,
    }
  }

  const visible = assignments
    .map(view)
    .filter((a): a is OfficiatingAssignment => a !== null)
    // Upcoming only. An assignment on a game that has already kicked off is not
    // something a referee can answer, accept or decline — carrying it in these
    // buckets makes "31 waiting on your answer" mean "31, most of which are in the
    // past", and puts a finished game in the "next match" slot. It also keeps this
    // in step with the count the nav badge shows, which was already time-bounded.
    .filter((a) => a.row.startTime.getTime() >= now.getTime())

  // Requests keep their whole history: a rejected one is worth reading after the
  // fact, unlike a pending assignment on a game that has been and gone.
  const requestViews: OfficiatingRequestView[] = requests.map((request) => ({
    requestId: request.id,
    position: request.position,
    status: request.status,
    note: request.note,
    decisionNote: request.decisionNote,
    decidedAt: request.decidedAt,
    createdAt: request.createdAt,
    row: rowsById.get(request.gameId) ?? null,
  }))

  // Games the referee already has a stake in are not "open" to them, whatever
  // their crew looks like: they are already on it, or already asked.
  const spokenFor = new Set<string>([
    ...assignments.map((a) => a.gameId),
    ...requests.filter((r) => r.status === 'pending' || r.status === 'approved').map((r) => r.gameId),
  ])

  /**
   * Crew composition is read live, not from the snapshot.
   *
   * A published version freezes the crew along with the fixtures, but a decline or
   * an unassignment happens operationally and does not wait for a new version to be
   * published. Computing open positions from the frozen crew would show a referee a
   * game as needing an AR that was filled an hour ago, and — worse — hide the ones
   * that opened up since, which is the entire situation this feature exists for.
   *
   * It also keeps the list in step with the request endpoint, which checks live rows
   * before accepting. The kickoff time and venue still come from whichever source
   * the reader is entitled to; only the crew is overlaid.
   */
  const liveOfficials = await prisma.gameOfficial.findMany({
    where: {
      deletedAt: null,
      game: { deletedAt: null, seasonId, season: { league: { orgId } } },
    },
    select: { gameId: true, position: true, status: true },
  })
  const crewByGame = new Map<string, Array<{ position: string; status: string }>>()
  for (const official of liveOfficials) {
    const bucket = crewByGame.get(official.gameId)
    if (bucket) bucket.push(official)
    else crewByGame.set(official.gameId, [official])
  }

  const candidates = schedule.rows
    .filter(
      (row) =>
        row.startTime.getTime() >= now.getTime() &&
        row.status !== 'cancelled' &&
        !spokenFor.has(row.id) &&
        openPositionsFor(crewByGame.get(row.id) ?? []).length > 0,
    )
    .slice(0, openLimit)

  const openGames = await evaluateOpenGames(refereeId, candidates, crewByGame)

  return {
    accepted: visible.filter((a) => a.status === 'accepted'),
    awaitingAnswer: visible.filter((a) => a.status === 'pending'),
    declined: visible.filter((a) => a.status === 'declined'),
    pendingRequests: requestViews.filter((r) => r.status === 'pending'),
    answeredRequests: requestViews.filter((r) => r.status !== 'pending'),
    openGames,
    source: schedule.source,
    orgTimezone: schedule.orgTimezone,
  }
}

/**
 * Crew positions nobody is holding.
 *
 * A declined assignment frees its position back up — that is the whole point of
 * declining — so it does not count as held. `scorekeeper` is excluded from the
 * expected crew: it is a real position in the schema but not one a match needs to
 * go ahead, and listing every game as short a scorekeeper would drown the signal.
 *
 * Takes the officials rather than a whole row so the request endpoint can apply the
 * identical rule to rows it loaded itself. A referee must never be shown a request
 * button the endpoint would then refuse.
 */
export function openPositionsFor(
  officials: ReadonlyArray<{ position: string; status: string }>,
): string[] {
  const held = new Set(
    officials.filter((official) => official.status !== 'declined').map((o) => o.position),
  )
  return CREW_POSITIONS.filter((position) => !held.has(position))
}

/**
 * Runs the hard rules over a batch of candidate games for one referee.
 *
 * Context is loaded once — availability, existing assignments, relationships — and
 * then the same pure `officialConflicts` the write path uses is applied per game.
 * That is the anti-drift guarantee: this cannot say "you may request that" about a
 * game the POST would refuse, because both answers come from one function.
 */
export async function evaluateOpenGames(
  refereeId: string,
  rows: ScheduleRow[],
  /**
   * Live crew per game. Pass it when the rows may have come from a published
   * snapshot, whose crew is frozen; omitted, the row's own officials are used.
   */
  crewByGame?: Map<string, Array<{ position: string; status: string }>>,
): Promise<OpenGame[]> {
  if (rows.length === 0) return []

  const [referee, teamPeople] = await Promise.all([
    loadRefereeConflictContext(refereeId),
    teamPersonIdsForGames(rows.map((row) => row.id)),
  ])
  if (!referee) return []

  return rows.map((row) => ({
    row,
    openPositions: openPositionsFor(crewByGame?.get(row.id) ?? row.officials),
    conflicts: officialConflicts(referee, {
      id: row.id,
      startTime: row.startTime,
      durationMinutes: row.durationMinutes,
      venueId: row.venueId,
      timezone: row.timezone,
      teamPersonIds: teamPeople.get(row.id) ?? new Set(),
    }),
  }))
}

/** Pending requests across an org, for the assignment board. */
export async function pendingRequestsForOrg(orgId: string) {
  return prisma.officiatingRequest.findMany({
    where: {
      status: 'pending',
      deletedAt: null,
      game: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
    },
    orderBy: [{ game: { startTime: 'asc' } }, { createdAt: 'asc' }],
    include: {
      referee: { include: { person: { select: { id: true, name: true } } } },
      game: {
        include: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
          division: { select: { name: true } },
          field: { include: { venue: { select: { name: true, timezone: true } } } },
        },
      },
    },
  })
}
