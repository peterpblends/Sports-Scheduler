import { prisma } from './prisma'
import { calendarDateInZone, dayOfWeekInZone, minutesFromMidnightInZone } from './time'

/**
 * Hard-constraint checking for a single game placement.
 *
 * These are the rules the spec calls hard: venue double-booking, a team playing
 * twice at once, referee availability, and blackout dates. They are checked here
 * — one game against the current state of the database — and reused by the phase 3
 * generator and the phase 5 drag-and-drop editor, so there is exactly one
 * definition of "this placement is illegal".
 *
 * Callers decide what to do with the result. The API refuses a conflicting write
 * unless an override reason is supplied, in which case it proceeds and logs it.
 */

export type ConflictKind =
  | 'field_double_booked'
  | 'team_double_booked'
  | 'outside_field_availability'
  | 'blackout_date'
  | 'referee_unavailable'
  | 'referee_daily_cap'
  | 'referee_conflict_of_interest'

export type Conflict = {
  kind: ConflictKind
  message: string
  /** Ids that help the UI point at the offending rows. */
  refs?: Record<string, string>
}

export type GamePlacement = {
  /** Set when checking an existing game, so it does not conflict with itself. */
  gameId?: string
  seasonId: string
  divisionId: string
  homeTeamId: string
  awayTeamId: string
  fieldId: string | null
  startTime: Date
  durationMinutes: number
}

/** Minutes of clearance required between two games on the same field. */
export type ConflictOptions = { bufferMinutes?: number }

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime()
}

export async function detectGameConflicts(
  orgId: string,
  placement: GamePlacement,
  options: ConflictOptions = {},
): Promise<Conflict[]> {
  const buffer = options.bufferMinutes ?? 0
  const start = placement.startTime
  const end = new Date(start.getTime() + placement.durationMinutes * 60_000)

  const conflicts: Conflict[] = []

  // A cancelled or postponed game does not hold its slot.
  const liveStatuses = ['scheduled', 'confirmed', 'played'] as const

  // Look at a generous window around the placement and filter precisely in memory;
  // this keeps the query simple and the overlap maths explicit.
  const windowStart = new Date(start.getTime() - 12 * 60 * 60_000)
  const windowEnd = new Date(end.getTime() + 12 * 60 * 60_000)

  const nearby = await prisma.game.findMany({
    where: {
      deletedAt: null,
      status: { in: [...liveStatuses] },
      startTime: { gte: windowStart, lte: windowEnd },
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
      ...(placement.gameId ? { id: { not: placement.gameId } } : {}),
    },
    select: {
      id: true,
      fieldId: true,
      startTime: true,
      durationMinutes: true,
      homeTeamId: true,
      awayTeamId: true,
    },
  })

  // --- field double-booking (buffer applies to the field, not the teams)
  if (placement.fieldId) {
    for (const other of nearby) {
      if (other.fieldId !== placement.fieldId) continue
      const otherStart = other.startTime
      const otherEnd = new Date(other.startTime.getTime() + other.durationMinutes * 60_000)
      const paddedStart = new Date(start.getTime() - buffer * 60_000)
      const paddedEnd = new Date(end.getTime() + buffer * 60_000)
      if (overlaps(paddedStart, paddedEnd, otherStart, otherEnd)) {
        conflicts.push({
          kind: 'field_double_booked',
          message: buffer
            ? `That field already has a game within ${buffer} minutes of this slot.`
            : 'That field is already booked for an overlapping game.',
          refs: { gameId: other.id, fieldId: placement.fieldId },
        })
        break
      }
    }
  }

  // --- a team cannot be in two places at once
  const teamIds = [placement.homeTeamId, placement.awayTeamId]
  for (const other of nearby) {
    const otherStart = other.startTime
    const otherEnd = new Date(other.startTime.getTime() + other.durationMinutes * 60_000)
    if (!overlaps(start, end, otherStart, otherEnd)) continue
    const clash = teamIds.find((id) => id === other.homeTeamId || id === other.awayTeamId)
    if (clash) {
      conflicts.push({
        kind: 'team_double_booked',
        message: 'One of these teams already has an overlapping game.',
        refs: { gameId: other.id, teamId: clash },
      })
      break
    }
  }

  // --- must fall inside the field's published availability
  if (placement.fieldId) {
    const outside = await isOutsideFieldAvailability(placement.fieldId, start, end)
    if (outside) conflicts.push(outside)
  }

  // --- blackout dates at any of the four scopes
  conflicts.push(...(await blackoutConflicts(orgId, placement, start)))

  return conflicts
}

/**
 * A placement must sit entirely within one published window for the field, in the
 * venue's local time. Recurring windows match on local day-of-week and are bounded
 * by their effective date range; one-off windows match a single local date.
 *
 * A field with no time slots at all is treated as unconstrained rather than
 * unusable — that is the useful default while a season is still being set up.
 */
async function isOutsideFieldAvailability(
  fieldId: string,
  start: Date,
  end: Date,
): Promise<Conflict | null> {
  const field = await prisma.field.findFirst({
    where: { id: fieldId, deletedAt: null },
    include: { venue: true, timeSlots: { where: { deletedAt: null } } },
  })
  if (!field || field.timeSlots.length === 0) return null

  const tz = field.venue.timezone
  const localDate = calendarDateInZone(start, tz)
  const localDay = dayOfWeekInZone(start, tz)
  const startMinutes = minutesFromMidnightInZone(start, tz)
  // Derive the end from the start so a game crossing local midnight still reads as
  // a single continuous span rather than wrapping to a small number.
  const endMinutes = startMinutes + Math.round((end.getTime() - start.getTime()) / 60_000)

  const fits = field.timeSlots.some((slot) => {
    if (slot.specificDate) {
      if (slot.specificDate.getTime() !== localDate.getTime()) return false
    } else {
      if (slot.dayOfWeek !== localDay) return false
      if (slot.effectiveFrom && localDate.getTime() < slot.effectiveFrom.getTime()) return false
      if (slot.effectiveTo && localDate.getTime() > slot.effectiveTo.getTime()) return false
    }
    return startMinutes >= slot.startMinute && endMinutes <= slot.endMinute
  })

  if (fits) return null
  return {
    kind: 'outside_field_availability',
    message: `${field.venue.name} ${field.name} is not available at that local time.`,
    refs: { fieldId },
  }
}

/** Blackouts at org, division, team or venue scope that cover the game's local date. */
async function blackoutConflicts(
  orgId: string,
  placement: GamePlacement,
  start: Date,
): Promise<Conflict[]> {
  let venueId: string | null = null
  let localDate = start

  if (placement.fieldId) {
    const field = await prisma.field.findFirst({
      where: { id: placement.fieldId, deletedAt: null },
      include: { venue: true },
    })
    if (field) {
      venueId = field.venueId
      localDate = calendarDateInZone(start, field.venue.timezone)
    }
  } else {
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    localDate = calendarDateInZone(start, org?.timezone ?? 'UTC')
  }

  const blackouts = await prisma.blackoutDate.findMany({
    where: {
      orgId,
      deletedAt: null,
      startDate: { lte: localDate },
      endDate: { gte: localDate },
      OR: [
        { scope: 'org' },
        { scope: 'division', divisionId: placement.divisionId },
        { scope: 'team', teamId: { in: [placement.homeTeamId, placement.awayTeamId] } },
        ...(venueId ? [{ scope: 'venue' as const, venueId }] : []),
      ],
    },
  })

  return blackouts.map((b) => ({
    kind: 'blackout_date' as const,
    message: `Blocked by a ${b.scope} blackout: ${b.reason}.`,
    refs: { blackoutId: b.id },
  }))
}

// ---------------------------------------------------------------------------
// Officiating
// ---------------------------------------------------------------------------

/**
 * Whether this referee may take this game. Covers the four official-side hard
 * rules: they must be available, under their daily cap, free of an overlapping
 * assignment, and not connected to either team.
 */
export async function detectOfficialConflicts(
  orgId: string,
  gameId: string,
  refereeId: string,
): Promise<Conflict[]> {
  const conflicts: Conflict[] = []

  const game = await prisma.game.findFirst({
    where: { id: gameId, deletedAt: null },
    include: { field: { include: { venue: true } } },
  })
  if (!game) return conflicts

  const referee = await prisma.referee.findFirst({
    where: { id: refereeId, deletedAt: null },
    include: {
      person: true,
      availability: { where: { deletedAt: null } },
      assignments: {
        where: { deletedAt: null, status: { not: 'declined' }, game: { deletedAt: null } },
        include: { game: { include: { field: { include: { venue: true } } } } },
      },
    },
  })
  if (!referee) return conflicts

  const tz = game.field?.venue.timezone ?? 'UTC'
  const start = game.startTime
  const end = new Date(start.getTime() + game.durationMinutes * 60_000)
  const localDate = calendarDateInZone(start, tz)
  const localDay = dayOfWeekInZone(start, tz)
  const startMinutes = minutesFromMidnightInZone(start, tz)
  const endMinutes = startMinutes + game.durationMinutes

  // --- conflict of interest: on either team, or related to someone who is
  const teamPeople = await prisma.teamMembership.findMany({
    where: { deletedAt: null, teamId: { in: [game.homeTeamId, game.awayTeamId] } },
    select: { personId: true, teamId: true },
  })
  const teamPersonIds = new Set(teamPeople.map((m) => m.personId))

  if (teamPersonIds.has(referee.personId)) {
    conflicts.push({
      kind: 'referee_conflict_of_interest',
      message: `${referee.person.name} is a member of one of these teams.`,
      refs: { refereeId, gameId },
    })
  } else {
    const relations = await prisma.personRelationship.findMany({
      where: { deletedAt: null, personId: referee.personId },
      select: { relatedPersonId: true },
    })
    const related = relations.find((r) => teamPersonIds.has(r.relatedPersonId))
    if (related) {
      conflicts.push({
        kind: 'referee_conflict_of_interest',
        message: `${referee.person.name} is related to someone on one of these teams.`,
        refs: { refereeId, gameId, relatedPersonId: related.relatedPersonId },
      })
    }
  }

  // --- availability: a blackout wins outright; otherwise a weekly window must cover it
  const blackout = referee.availability.find(
    (a) =>
      a.kind === 'blackout' &&
      a.effectiveFrom &&
      a.effectiveTo &&
      localDate.getTime() >= a.effectiveFrom.getTime() &&
      localDate.getTime() <= a.effectiveTo.getTime(),
  )
  if (blackout) {
    conflicts.push({
      kind: 'referee_unavailable',
      message: `${referee.person.name} has a blackout on that date${blackout.reason ? ` (${blackout.reason})` : ''}.`,
      refs: { refereeId, availabilityId: blackout.id },
    })
  } else {
    const weekly = referee.availability.filter((a) => a.kind === 'weekly')
    // As with fields, no declared windows means "no stated restriction".
    if (weekly.length > 0) {
      const covered = weekly.some(
        (a) =>
          a.dayOfWeek === localDay &&
          a.startMinute !== null &&
          a.endMinute !== null &&
          startMinutes >= a.startMinute &&
          endMinutes <= a.endMinute &&
          (!a.effectiveFrom || localDate.getTime() >= a.effectiveFrom.getTime()) &&
          (!a.effectiveTo || localDate.getTime() <= a.effectiveTo.getTime()),
      )
      if (!covered) {
        conflicts.push({
          kind: 'referee_unavailable',
          message: `${referee.person.name} is not available at that local time.`,
          refs: { refereeId },
        })
      }
    }
  }

  // --- overlapping assignment, or too little travel time between venues
  for (const assignment of referee.assignments) {
    if (assignment.gameId === gameId) continue
    const other = assignment.game
    const otherStart = other.startTime
    const otherEnd = new Date(other.startTime.getTime() + other.durationMinutes * 60_000)

    if (overlaps(start, end, otherStart, otherEnd)) {
      conflicts.push({
        kind: 'referee_unavailable',
        message: `${referee.person.name} already has an overlapping assignment.`,
        refs: { refereeId, gameId: other.id },
      })
      continue
    }

    const differentVenue =
      other.field && game.field && other.field.venueId !== game.field.venueId
    if (differentVenue) {
      const gapMinutes =
        otherStart.getTime() >= end.getTime()
          ? (otherStart.getTime() - end.getTime()) / 60_000
          : (start.getTime() - otherEnd.getTime()) / 60_000
      if (gapMinutes < referee.travelBufferMinutes) {
        conflicts.push({
          kind: 'referee_unavailable',
          message: `${referee.person.name} needs ${referee.travelBufferMinutes} minutes to travel between venues; only ${Math.round(gapMinutes)} available.`,
          refs: { refereeId, gameId: other.id },
        })
      }
    }
  }

  // --- daily cap, counted in the local day of each game's own venue
  const sameDay = referee.assignments.filter((assignment) => {
    if (assignment.gameId === gameId) return false
    const otherTz = assignment.game.field?.venue.timezone ?? tz
    return calendarDateInZone(assignment.game.startTime, otherTz).getTime() === localDate.getTime()
  })
  if (sameDay.length + 1 > referee.maxGamesPerDay) {
    conflicts.push({
      kind: 'referee_daily_cap',
      message: `${referee.person.name} is capped at ${referee.maxGamesPerDay} games per day and already has ${sameDay.length}.`,
      refs: { refereeId },
    })
  }

  return conflicts
}
