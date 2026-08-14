import { prisma } from './prisma'
import { forbidden, notFound, requirePermission } from './http'
import { can } from './authz'
import type { Actor } from './session'
import type { Role } from '@prisma/client'

/**
 * Tenant scoping.
 *
 * Every entity in the app hangs off an Organization, sometimes several links
 * away: a Team belongs to a Division, which belongs to a Season, which belongs to
 * a League, which belongs to the org. An endpoint that takes both an `orgId` (for
 * the permission check) and an entity id must prove the entity actually lives
 * under that org — otherwise a member of org A could pass their own orgId with a
 * team id from org B and the permission check would happily pass.
 *
 * The `assert*InOrg` helpers below are that proof. Each one resolves the full
 * chain in a single query and throws 404 if it does not terminate at `orgId`.
 * 404 rather than 403: the existence of another tenant's row is not ours to
 * confirm.
 */

export async function assertLeagueInOrg(orgId: string, leagueId: string) {
  const league = await prisma.league.findFirst({
    where: { id: leagueId, orgId, deletedAt: null },
  })
  if (!league) throw notFound('League not found.')
  return league
}

export async function assertSeasonInOrg(orgId: string, seasonId: string) {
  const season = await prisma.season.findFirst({
    where: { id: seasonId, deletedAt: null, league: { orgId, deletedAt: null } },
    include: { league: true },
  })
  if (!season) throw notFound('Season not found.')
  return season
}

export async function assertDivisionInOrg(orgId: string, divisionId: string) {
  const division = await prisma.division.findFirst({
    where: {
      id: divisionId,
      deletedAt: null,
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
    },
    include: { season: { include: { league: true } } },
  })
  if (!division) throw notFound('Division not found.')
  return division
}

export async function assertTeamInOrg(orgId: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      deletedAt: null,
      division: {
        deletedAt: null,
        season: { deletedAt: null, league: { orgId, deletedAt: null } },
      },
    },
    include: { division: { include: { season: { include: { league: true } } } } },
  })
  if (!team) throw notFound('Team not found.')
  return team
}

export async function assertPersonInOrg(orgId: string, personId: string) {
  const person = await prisma.person.findFirst({
    where: { id: personId, orgId, deletedAt: null },
  })
  if (!person) throw notFound('Person not found.')
  return person
}

export async function assertVenueInOrg(orgId: string, venueId: string) {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, orgId, deletedAt: null },
  })
  if (!venue) throw notFound('Venue not found.')
  return venue
}

export async function assertFieldInOrg(orgId: string, fieldId: string) {
  const field = await prisma.field.findFirst({
    where: { id: fieldId, deletedAt: null, venue: { orgId, deletedAt: null } },
    include: { venue: true },
  })
  if (!field) throw notFound('Field not found.')
  return field
}

export async function assertTimeSlotInOrg(orgId: string, timeSlotId: string) {
  const slot = await prisma.timeSlot.findFirst({
    where: {
      id: timeSlotId,
      deletedAt: null,
      field: { deletedAt: null, venue: { orgId, deletedAt: null } },
    },
    include: { field: { include: { venue: true } } },
  })
  if (!slot) throw notFound('Time slot not found.')
  return slot
}

export async function assertRefereeInOrg(orgId: string, refereeId: string) {
  const referee = await prisma.referee.findFirst({
    where: { id: refereeId, deletedAt: null, person: { orgId, deletedAt: null } },
    include: { person: true },
  })
  if (!referee) throw notFound('Referee not found.')
  return referee
}

export async function assertGameInOrg(orgId: string, gameId: string) {
  const game = await prisma.game.findFirst({
    where: {
      id: gameId,
      deletedAt: null,
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
    },
    include: {
      season: { include: { league: true } },
      homeTeam: true,
      awayTeam: true,
      field: { include: { venue: true } },
    },
  })
  if (!game) throw notFound('Game not found.')
  return game
}

export async function assertGameOfficialInOrg(orgId: string, assignmentId: string) {
  const assignment = await prisma.gameOfficial.findFirst({
    where: {
      id: assignmentId,
      deletedAt: null,
      game: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
    },
    include: {
      game: { include: { field: { include: { venue: true } } } },
      referee: { include: { person: true } },
    },
  })
  if (!assignment) throw notFound('Assignment not found.')
  return assignment
}

export async function assertOfficiatingRequestInOrg(orgId: string, requestId: string) {
  const request = await prisma.officiatingRequest.findFirst({
    where: {
      id: requestId,
      deletedAt: null,
      game: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
    },
    include: {
      game: { include: { homeTeam: true, awayTeam: true, field: { include: { venue: true } } } },
      referee: { include: { person: true } },
    },
  })
  if (!request) throw notFound('Request not found.')
  return request
}

export async function assertBlackoutInOrg(orgId: string, blackoutId: string) {
  const blackout = await prisma.blackoutDate.findFirst({
    where: { id: blackoutId, orgId, deletedAt: null },
  })
  if (!blackout) throw notFound('Blackout not found.')
  return blackout
}

// ---------------------------------------------------------------------------
// Own-team and own-assignment scope
// ---------------------------------------------------------------------------

/** Team roles that make someone staff of a team rather than a player on it. */
const STAFF_ROLES = ['coach', 'assistant', 'manager'] as const

/**
 * Teams the signed-in user is staff of, inside this org.
 *
 * Resolved through `Person.userId` — a login is tied to a Person record, and that
 * Person's staff TeamMemberships are their teams. A user with no linked Person,
 * or a Person on no teams, gets an empty list, which means every `:own` check
 * fails closed.
 */
export async function staffTeamIds(userId: string, orgId: string): Promise<string[]> {
  const memberships = await prisma.teamMembership.findMany({
    where: {
      deletedAt: null,
      role: { in: [...STAFF_ROLES] },
      person: { userId, orgId, deletedAt: null },
      team: {
        deletedAt: null,
        division: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
      },
    },
    select: { teamId: true },
  })
  return [...new Set(memberships.map((m) => m.teamId))]
}

/**
 * The same teams as `staffTeamIds`, with enough to label a link.
 *
 * Separate from `staffTeamIds` rather than replacing it: the authorization checks
 * want a cheap id list and should not pull names they will never read.
 */
export async function staffTeams(
  userId: string,
  orgId: string,
): Promise<Array<{ id: string; name: string; divisionName: string }>> {
  const memberships = await prisma.teamMembership.findMany({
    where: {
      deletedAt: null,
      role: { in: [...STAFF_ROLES] },
      person: { userId, orgId, deletedAt: null },
      team: {
        deletedAt: null,
        division: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
      },
    },
    select: {
      team: { select: { id: true, name: true, division: { select: { name: true } } } },
    },
    orderBy: { team: { name: 'asc' } },
  })

  const byId = new Map(
    memberships.map((membership) => [
      membership.team.id,
      {
        id: membership.team.id,
        name: membership.team.name,
        divisionName: membership.team.division.name,
      },
    ]),
  )
  return [...byId.values()]
}

/** The Referee record belonging to the signed-in user in this org, if any. */
export async function refereeForUser(userId: string, orgId: string) {
  return prisma.referee.findFirst({
    where: { deletedAt: null, person: { userId, orgId, deletedAt: null } },
    include: { person: true },
  })
}

/**
 * Authorizes a write against one specific team's roster.
 *
 * Two ways to pass, and they are checked in this order:
 *   1. `roster:write` — org-wide roster control (owner, admin).
 *   2. `roster:write:own` — a coach, but *only* for a team they are staff of.
 *
 * A coach acting on any other team lands in the final `forbidden()`. This is the
 * check behind the "a coach token cannot mutate another team's data" guarantee.
 */
export async function requireTeamRosterWrite(
  req: Request,
  orgId: string,
  teamId: string,
): Promise<{ actor: Actor; role: Role; scoped: boolean }> {
  // `org:read` is the floor every member holds; the real decision is below, so
  // that a coach is not rejected before their own-scope path is considered.
  const { actor, role } = await requirePermission(req, orgId, 'org:read')

  // Prove the team is in this org before revealing anything about it.
  await assertTeamInOrg(orgId, teamId)

  if (can(role, 'roster:write')) return { actor, role, scoped: false }

  if (can(role, 'roster:write:own')) {
    const own = await staffTeamIds(actor.userId, orgId)
    if (own.includes(teamId)) return { actor, role, scoped: true }
    throw forbidden('You can only change the roster of a team you coach.')
  }

  throw forbidden('You do not have permission to change rosters.')
}

/**
 * Authorizes a referee-availability write. Schedulers and admins may edit anyone's;
 * a referee may edit only their own.
 */
export async function requireAvailabilityWrite(
  req: Request,
  orgId: string,
  refereeId: string,
): Promise<{ actor: Actor; role: Role; scoped: boolean }> {
  const { actor, role } = await requirePermission(req, orgId, 'org:read')
  await assertRefereeInOrg(orgId, refereeId)

  if (can(role, 'official:availability:write')) return { actor, role, scoped: false }

  if (can(role, 'official:availability:write:own')) {
    const own = await refereeForUser(actor.userId, orgId)
    if (own?.id === refereeId) return { actor, role, scoped: true }
    throw forbidden('You can only set your own availability.')
  }

  throw forbidden('You do not have permission to set availability.')
}

/**
 * Authorizes creating an officiating request, and resolves *whose* it is.
 *
 * The referee is resolved from the session, never from the request body. There is
 * deliberately no `refereeId` field on the create schema: if there were, a referee
 * could volunteer somebody else for a game, and a compromised session could be
 * used to manufacture assignments for a third party. The only referee a caller can
 * request for is the one their own login resolves to.
 *
 * A member with no linked Referee record is refused rather than silently ignored,
 * because "you are not registered as an official" is the actionable answer.
 */
export async function requireOwnRefereeRequest(
  req: Request,
  orgId: string,
): Promise<{
  actor: Actor
  role: Role
  referee: { id: string; personId: string; name: string }
}> {
  const { actor, role } = await requirePermission(req, orgId, 'official:request:own')
  const referee = await refereeForUser(actor.userId, orgId)
  if (!referee) {
    throw forbidden('You are not registered as an official in this organization.')
  }
  return {
    actor,
    role,
    referee: { id: referee.id, personId: referee.personId, name: referee.person.name },
  }
}

/**
 * Authorizes withdrawing a request. A referee may withdraw their own; an assigner
 * may retract anyone's — which is distinct from rejecting one, and audited
 * separately.
 */
export async function requireOfficiatingRequestWithdraw(
  req: Request,
  orgId: string,
  requestId: string,
): Promise<{ actor: Actor; role: Role; scoped: boolean }> {
  const { actor, role } = await requirePermission(req, orgId, 'org:read')
  const request = await assertOfficiatingRequestInOrg(orgId, requestId)

  if (can(role, 'official:request:review')) return { actor, role, scoped: false }

  if (can(role, 'official:request:own')) {
    const own = await refereeForUser(actor.userId, orgId)
    if (own?.id === request.refereeId) return { actor, role, scoped: true }
    throw forbidden('You can only withdraw your own requests.')
  }

  throw forbidden('You do not have permission to change officiating requests.')
}

/**
 * Authorizes responding to an officiating assignment. An assigner may set any
 * assignment's status; a referee may only respond to their own.
 */
export async function requireAssignmentRespond(
  req: Request,
  orgId: string,
  assignmentId: string,
): Promise<{ actor: Actor; role: Role; scoped: boolean }> {
  const { actor, role } = await requirePermission(req, orgId, 'org:read')
  const assignment = await assertGameOfficialInOrg(orgId, assignmentId)

  if (can(role, 'official:assign')) return { actor, role, scoped: false }

  if (can(role, 'official:respond:own')) {
    const own = await refereeForUser(actor.userId, orgId)
    if (own?.id === assignment.refereeId) return { actor, role, scoped: true }
    throw forbidden('You can only respond to your own assignments.')
  }

  throw forbidden('You do not have permission to change assignments.')
}
