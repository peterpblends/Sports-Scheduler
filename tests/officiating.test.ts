import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  CapturingMailer,
  call,
  createDivision,
  createField,
  createLeague,
  createOrganization,
  createPerson,
  createRecurringSlot,
  createReferee,
  createSeason,
  createTeam,
  createVenue,
  inviteAndAccept,
  resetDatabase,
  signUp,
  useCapturingMailer,
  type TestUser,
} from './helpers'

import { POST as generate } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/generate/route'
import { POST as publish } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/[versionId]/publish/route'
import { GET as listVersions } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/route'
import { POST as assignOfficial } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/route'
import { PATCH as respondToAssignment } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/[assignmentId]/route'
import {
  GET as listGameRequests,
  POST as requestGame,
} from '@/app/api/orgs/[orgId]/games/[gameId]/officiating-requests/route'
import { GET as listOrgRequests } from '@/app/api/orgs/[orgId]/officiating-requests/route'
import {
  DELETE as withdrawRequest,
  PATCH as decideRequest,
} from '@/app/api/orgs/[orgId]/officiating-requests/[requestId]/route'
import { POST as setAvailability } from '@/app/api/orgs/[orgId]/referees/[refereeId]/availability/route'

import { detectOfficialConflicts } from '@/lib/conflicts'
import { evaluateOpenGames, loadRefereeBoard, openPositionsFor } from '@/lib/officiating'
import { readSchedule } from '@/lib/schedule/read'
import { calendarDateInZone, formatCalendarDate } from '@/lib/time'

/**
 * Referee self-service: the four buckets a referee cares about, and asking for a
 * game that is short an official.
 *
 * The rules under test are mostly refusals, which is the point. A referee may
 * volunteer, but they may not volunteer *for someone else*, they may not wave away
 * a conflict of interest that a scheduler would have to override deliberately, and
 * they may not approve their own request. Each of those is a separate `it`.
 */

let mailer: CapturingMailer
let owner: TestUser
let scheduler: TestUser
let coach: TestUser
let viewer: TestUser
let refUser: TestUser
let plainRefUser: TestUser

let org: { id: string; slug: string }
let season: { id: string }
let division: { id: string }
let teamIds: string[]
let refereeId: string
let refereePersonId: string
let otherRefereeId: string

// The season sits in the future on purpose: a request for a game that has already
// kicked off is refused, so a past-dated fixture would make every test here a 400.
const SEASON_START = '2027-03-06'
const SEASON_END = '2027-05-29'

const gen = (actor: TestUser, body: Record<string, unknown>) =>
  call<{ orgId: string; seasonId: string }>(
    generate,
    `/api/orgs/${org.id}/seasons/${season.id}/generate`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id }, body },
  )

const ask = (actor: TestUser, gameId: string, body: Record<string, unknown>) =>
  call<{ orgId: string; gameId: string }>(
    requestGame,
    `/api/orgs/${org.id}/games/${gameId}/officiating-requests`,
    { token: actor.token, params: { orgId: org.id, gameId }, body },
  )

const decide = (actor: TestUser, requestId: string, body: Record<string, unknown>) =>
  call<{ orgId: string; requestId: string }>(
    decideRequest,
    `/api/orgs/${org.id}/officiating-requests/${requestId}`,
    { token: actor.token, method: 'PATCH', params: { orgId: org.id, requestId }, body },
  )

const withdraw = (actor: TestUser, requestId: string) =>
  call<{ orgId: string; requestId: string }>(
    withdrawRequest,
    `/api/orgs/${org.id}/officiating-requests/${requestId}`,
    { token: actor.token, method: 'DELETE', params: { orgId: org.id, requestId } },
  )

const board = (canReadDrafts = true) =>
  loadRefereeBoard({ orgId: org.id, seasonId: season.id, refereeId, canReadDrafts })

const futureGames = () =>
  prisma.game.findMany({
    where: { deletedAt: null, seasonId: season.id, startTime: { gt: new Date() } },
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    include: { officials: { where: { deletedAt: null } }, field: { include: { venue: true } } },
  })

/** A game with every crew position free, which is what a referee can ask for. */
async function openGame() {
  const all = await futureGames()
  const found = all.find((game) => openPositionsFor(game.officials).length === 3)
  if (!found) throw new Error('fixture has no fully unstaffed future game')
  return found
}

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()

  owner = await signUp('owner@example.com')
  org = await createOrganization(owner)
  scheduler = await inviteAndAccept(owner, org.id, 'scheduler@example.com', 'scheduler', mailer)
  coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
  viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)
  refUser = await inviteAndAccept(owner, org.id, 'ref@example.com', 'referee', mailer)
  // A second referee-role member with no Referee record, to prove the endpoint
  // distinguishes "you may ask" from "you are registered as an official".
  plainRefUser = await inviteAndAccept(owner, org.id, 'notref@example.com', 'referee', mailer)

  const league = await createLeague(owner, org.id, 'Recreational')
  season = await createSeason(owner, org.id, league.id, {
    name: 'Spring 2027',
    startDate: SEASON_START,
    endDate: SEASON_END,
  })
  division = await createDivision(owner, org.id, season.id, 'U12 Boys')

  teamIds = []
  for (const name of ['Rovers', 'Owls', 'Breakers', 'Falcons']) {
    const team = await createTeam(owner, org.id, division.id, name)
    teamIds.push(team.id)
  }

  const venue = await createVenue(owner, org.id, 'Riverside Park')
  for (const name of ['Field 1', 'Field 2']) {
    const field = await createField(owner, org.id, venue.id, name)
    await createRecurringSlot(owner, org.id, field.id, {
      dayOfWeek: 6,
      startTime: '08:00',
      endTime: '18:00',
      effectiveFrom: '2027-03-01',
      effectiveTo: '2027-05-31',
    })
  }

  // The referee's Person is linked to their login — that link is what
  // `refereeForUser` resolves, and without it every `:own` check fails closed.
  const refPerson = await createPerson(owner, org.id, 'Wei Chen', {
    email: 'ref@example.com',
    userId: refUser.id,
  })
  refereePersonId = refPerson.id
  refereeId = (await createReferee(owner, org.id, refPerson.id, { maxGamesPerDay: 3 })).id

  const otherPerson = await createPerson(owner, org.id, 'Dana Vaughn')
  otherRefereeId = (await createReferee(owner, org.id, otherPerson.id)).id

  // Generated without officials so the crew slots start open.
  const res = await gen(owner, {
    commit: true,
    config: { seed: 7, roundRobinTimes: 1, assignOfficials: false },
  })
  if (res.status !== 200) throw new Error(`fixture generate failed: ${JSON.stringify(res.body)}`)
})

// ---------------------------------------------------------------------------
// Asking for a game
// ---------------------------------------------------------------------------

describe('a referee asking to officiate', () => {
  it('creates a pending request without putting them on the crew', async () => {
    const game = await openGame()

    const res = await ask(refUser, game.id, { position: 'center', note: 'Happy to take this one.' })

    expect(res.status).toBe(201)
    expect(res.body.request.status).toBe('pending')
    expect(res.body.request.refereeId).toBe(refereeId)

    // The crucial part: asking is not being assigned. A GameOfficial row here
    // would consume the referee's daily cap and block them from other games.
    const officials = await prisma.gameOfficial.findMany({ where: { gameId: game.id } })
    expect(officials).toHaveLength(0)

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: 'OfficiatingRequest', action: 'officiating_request.created' },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actorLabel).toBe('ref@example.com')
  })

  it('takes the referee from the session, ignoring any refereeId in the body', async () => {
    const game = await openGame()

    const res = await ask(refUser, game.id, { position: 'center', refereeId: otherRefereeId })

    expect(res.status).toBe(201)
    // Not Dana. A referee cannot volunteer somebody else, and the schema has no
    // refereeId field for exactly this reason.
    expect(res.body.request.refereeId).toBe(refereeId)

    const stored = await prisma.officiatingRequest.findMany({ where: { gameId: game.id } })
    expect(stored).toHaveLength(1)
    expect(stored[0]!.refereeId).toBe(refereeId)
  })

  it('notifies the people who can answer, but not the referee who asked', async () => {
    const game = await openGame()
    mailer.sent.length = 0

    const res = await ask(refUser, game.id, { position: 'center' })
    expect(res.status).toBe(201)

    const to = mailer.sent.map((mail) => mail.to).sort()
    expect(to).toContain('owner@example.com')
    expect(to).toContain('scheduler@example.com')
    expect(to).not.toContain('ref@example.com')
    // A coach cannot review requests, so must not be told about them.
    expect(to).not.toContain('coach@example.com')
  })

  it('refuses a second request on the same game', async () => {
    const game = await openGame()
    expect((await ask(refUser, game.id, { position: 'center' })).status).toBe(201)

    const again = await ask(refUser, game.id, { position: 'AR1' })

    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already have a request pending/i)
  })

  it('refuses a position somebody already holds', async () => {
    const game = await openGame()
    const assigned = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${game.id}/officials`,
      {
        token: scheduler.token,
        params: { orgId: org.id, gameId: game.id },
        body: { refereeId: otherRefereeId, position: 'center' },
      },
    )
    expect(assigned.status).toBe(201)

    const res = await ask(refUser, game.id, { position: 'center' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already has a center/i)

    // The other two positions are still available to them.
    expect((await ask(refUser, game.id, { position: 'AR1' })).status).toBe(201)
  })

  it('refuses a game that has already started', async () => {
    const game = await openGame()
    await prisma.game.update({
      where: { id: game.id },
      data: { startTime: new Date(Date.now() - 60 * 60 * 1000) },
    })

    const res = await ask(refUser, game.id, { position: 'center' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already started/i)
  })

  it('refuses a cancelled game', async () => {
    const game = await openGame()
    await prisma.game.update({ where: { id: game.id }, data: { status: 'cancelled' } })

    const res = await ask(refUser, game.id, { position: 'center' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Hard constraints, which a referee cannot override for themselves
// ---------------------------------------------------------------------------

describe('hard constraints on a self-request', () => {
  it('refuses a conflict of interest outright, with no override available', async () => {
    const game = await openGame()

    // Put the referee's own Person on one of the two teams.
    await prisma.teamMembership.create({
      data: { teamId: game.homeTeamId, personId: refereePersonId, role: 'coach' },
    })

    const res = await ask(refUser, game.id, { position: 'center' })

    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'referee_conflict_of_interest',
    )

    // Nothing was written, and there is no reason string that would change that:
    // the create schema has no overrideReason, so a referee cannot self-approve
    // past the rule the way an assigner deliberately can.
    expect(await prisma.officiatingRequest.count()).toBe(0)
  })

  it('refuses a game a relative of the referee is playing in', async () => {
    const game = await openGame()

    const relative = await createPerson(owner, org.id, 'Sam Chen')
    await prisma.teamMembership.create({
      data: { teamId: game.awayTeamId, personId: relative.id, role: 'player' },
    })
    await prisma.personRelationship.create({
      data: { personId: refereePersonId, relatedPersonId: relative.id, kind: 'family' },
    })

    const res = await ask(refUser, game.id, { position: 'center' })

    expect(res.status).toBe(409)
    expect(res.body.details.conflicts[0].kind).toBe('referee_conflict_of_interest')
    expect(res.body.details.conflicts[0].message).toMatch(/related to/i)
  })

  it('refuses a date the referee has blacked out, and says which', async () => {
    const game = await openGame()
    // The blackout is a calendar date in the venue's zone, not a UTC date. Using
    // the UTC date would silently miss for any evening kickoff west of Greenwich.
    const localDate = formatCalendarDate(
      calendarDateInZone(game.startTime, game.field!.venue.timezone),
    )

    const availability = await call<{ orgId: string; refereeId: string }>(
      setAvailability,
      `/api/orgs/${org.id}/referees/${refereeId}/availability`,
      {
        token: refUser.token,
        params: { orgId: org.id, refereeId },
        body: {
          kind: 'blackout',
          startDate: localDate,
          endDate: localDate,
          reason: 'Away that weekend',
        },
      },
    )
    expect(availability.status).toBe(201)

    const res = await ask(refUser, game.id, { position: 'center' })

    expect(res.status).toBe(409)
    const kinds = res.body.details.conflicts.map((c: { kind: string }) => c.kind)
    expect(kinds).toContain('referee_unavailable')
    expect(
      res.body.details.conflicts.some((c: { message: string }) => /Away that weekend/.test(c.message)),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Who may ask, and who may decide
// ---------------------------------------------------------------------------

describe('authorization on officiating requests', () => {
  it('refuses a coach and a viewer', async () => {
    const game = await openGame()

    expect((await ask(coach, game.id, { position: 'center' })).status).toBe(403)
    expect((await ask(viewer, game.id, { position: 'center' })).status).toBe(403)
    expect(await prisma.officiatingRequest.count()).toBe(0)
  })

  it('tells a referee-role member with no Referee record why they cannot ask', async () => {
    const game = await openGame()

    const res = await ask(plainRefUser, game.id, { position: 'center' })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not registered as an official/i)
  })

  it('refuses a referee approving their own request', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })
    expect(created.status).toBe(201)

    const res = await decide(refUser, created.body.request.id, { decision: 'approved' })

    expect(res.status).toBe(403)
    // And the request is untouched, not merely un-approved.
    const stored = await prisma.officiatingRequest.findUniqueOrThrow({
      where: { id: created.body.request.id },
    })
    expect(stored.status).toBe('pending')
    expect(stored.decidedById).toBeNull()
    expect(await prisma.gameOfficial.count()).toBe(0)
  })

  it('keeps the pending-request inbox away from referees, coaches and viewers', async () => {
    const game = await openGame()
    await ask(refUser, game.id, { position: 'center' })

    for (const actor of [refUser, coach, viewer]) {
      const res = await call<{ orgId: string }>(
        listOrgRequests,
        `/api/orgs/${org.id}/officiating-requests`,
        { token: actor.token, params: { orgId: org.id } },
      )
      expect(res.status).toBe(403)
    }

    const allowed = await call<{ orgId: string }>(
      listOrgRequests,
      `/api/orgs/${org.id}/officiating-requests`,
      { token: scheduler.token, params: { orgId: org.id } },
    )
    expect(allowed.status).toBe(200)
    expect(allowed.body.requests).toHaveLength(1)
    expect(allowed.body.requests[0].referee.name).toBe('Wei Chen')
    // Rendered in the venue's zone, not raw UTC.
    expect(allowed.body.requests[0].game.localStartTime).not.toMatch(/Z$/)
  })

  it('shows a referee only their own request on a game', async () => {
    const game = await openGame()
    await ask(refUser, game.id, { position: 'center' })
    // A competing request from the other referee, created directly since only the
    // session's own referee can be requested for through the endpoint.
    await prisma.officiatingRequest.create({
      data: { gameId: game.id, refereeId: otherRefereeId, position: 'AR1' },
    })

    const asReferee = await call<{ orgId: string; gameId: string }>(
      listGameRequests,
      `/api/orgs/${org.id}/games/${game.id}/officiating-requests`,
      { token: refUser.token, params: { orgId: org.id, gameId: game.id } },
    )
    expect(asReferee.status).toBe(200)
    expect(asReferee.body.requests).toHaveLength(1)
    expect(asReferee.body.requests[0].refereeId).toBe(refereeId)

    const asScheduler = await call<{ orgId: string; gameId: string }>(
      listGameRequests,
      `/api/orgs/${org.id}/games/${game.id}/officiating-requests`,
      { token: scheduler.token, params: { orgId: org.id, gameId: game.id } },
    )
    expect(asScheduler.body.requests).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

describe('approving and rejecting', () => {
  it('approval creates an accepted assignment and audits both rows', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'AR1', note: 'Available all day.' })
    mailer.sent.length = 0

    const res = await decide(scheduler, created.body.request.id, {
      decision: 'approved',
      decisionNote: 'Thanks for volunteering.',
    })

    expect(res.status).toBe(200)
    expect(res.body.request.status).toBe('approved')
    expect(res.body.assignment.position).toBe('AR1')

    const assignment = await prisma.gameOfficial.findFirstOrThrow({ where: { gameId: game.id } })
    expect(assignment.refereeId).toBe(refereeId)
    // Accepted, not pending: they asked for it, so there is nothing left to agree to.
    expect(assignment.status).toBe('accepted')
    expect(assignment.respondedAt).not.toBeNull()

    const actions = (
      await prisma.auditEvent.findMany({
        where: { entityId: { in: [created.body.request.id, assignment.id] } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.action)
    expect(actions).toContain('officiating_request.approved')
    expect(actions).toContain('official.assigned')

    // The assignment's own event records how it came about, so reading the game's
    // history explains the crew without having to find the request.
    const assigned = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: assignment.id, action: 'official.assigned' },
    })
    expect((assigned.meta as { via?: string }).via).toBe('request')

    expect(mailer.sent.map((mail) => mail.to)).toEqual(['ref@example.com'])
    expect(mailer.last().text).toMatch(/approved/i)
  })

  it('rejection records the reason and creates no assignment', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })

    const res = await decide(scheduler, created.body.request.id, {
      decision: 'rejected',
      decisionNote: 'Keeping you for the later kickoff.',
    })

    expect(res.status).toBe(200)
    expect(await prisma.gameOfficial.count()).toBe(0)

    const stored = await prisma.officiatingRequest.findUniqueOrThrow({
      where: { id: created.body.request.id },
    })
    expect(stored.status).toBe('rejected')
    // Kept on the row, not only in the audit trail, because the referee needs to
    // read it and does not hold audit:read.
    expect(stored.decisionNote).toBe('Keeping you for the later kickoff.')

    expect(mailer.last().to).toBe('ref@example.com')
    expect(mailer.last().text).toMatch(/Keeping you for the later kickoff/)
  })

  it('refuses to decide the same request twice', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })
    expect((await decide(scheduler, created.body.request.id, { decision: 'rejected' })).status).toBe(200)

    const again = await decide(scheduler, created.body.request.id, { decision: 'approved' })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already rejected/i)
  })

  it('refuses an approval when the position was taken while the request waited', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })

    // Somebody else gets the shirt in the meantime.
    await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${game.id}/officials`,
      {
        token: scheduler.token,
        params: { orgId: org.id, gameId: game.id },
        body: { refereeId: otherRefereeId, position: 'center' },
      },
    )

    const res = await decide(scheduler, created.body.request.id, { decision: 'approved' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already has a center/i)
    // The request stays pending so it can be rejected explicitly rather than
    // silently dying.
    const stored = await prisma.officiatingRequest.findUniqueOrThrow({
      where: { id: created.body.request.id },
    })
    expect(stored.status).toBe('pending')
  })

  it('re-checks the hard rules at approval time, not at request time', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })
    expect(created.status).toBe(201)

    // The conflict appears after the request was legitimately made.
    await prisma.teamMembership.create({
      data: { teamId: game.homeTeamId, personId: refereePersonId, role: 'coach' },
    })

    const refused = await decide(scheduler, created.body.request.id, { decision: 'approved' })
    expect(refused.status).toBe(409)
    expect(refused.body.details.conflicts[0].kind).toBe('referee_conflict_of_interest')

    // An assigner, unlike the referee, may override — and the reason is recorded
    // against the specific conflict.
    const forced = await decide(scheduler, created.body.request.id, {
      decision: 'approved',
      overrideReason: 'Parent has recused from coaching this fixture.',
    })
    expect(forced.status).toBe(200)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'officiating_request.approved' },
    })
    const meta = event.meta as { overrideReason?: string; overriddenConflicts?: unknown[] }
    expect(meta.overrideReason).toMatch(/recused/)
    expect(meta.overriddenConflicts).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Withdrawing
// ---------------------------------------------------------------------------

describe('withdrawing a request', () => {
  it('lets the referee take their own back, leaving an audit row', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })

    const res = await withdraw(refUser, created.body.request.id)
    expect(res.status).toBe(200)

    const stored = await prisma.officiatingRequest.findUniqueOrThrow({
      where: { id: created.body.request.id },
    })
    // Soft-deleted, never removed — non-negotiable #2.
    expect(stored.deletedAt).not.toBeNull()
    expect(stored.status).toBe('withdrawn')

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: created.body.request.id, action: 'officiating_request.withdrawn' },
    })
    expect(audit.actorLabel).toBe('ref@example.com')
  })

  it('records an assigner clearing a request as a different event', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })

    expect((await withdraw(scheduler, created.body.request.id)).status).toBe(200)

    // Same state change, different story: the audit trail should not claim the
    // referee changed their own mind.
    expect(
      await prisma.auditEvent.count({
        where: { entityId: created.body.request.id, action: 'officiating_request.retracted' },
      }),
    ).toBe(1)
  })

  it('refuses a referee withdrawing somebody else’s request', async () => {
    const game = await openGame()
    const other = await prisma.officiatingRequest.create({
      data: { gameId: game.id, refereeId: otherRefereeId, position: 'center' },
    })

    const res = await withdraw(refUser, other.id)

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only withdraw your own/i)
    const stored = await prisma.officiatingRequest.findUniqueOrThrow({ where: { id: other.id } })
    expect(stored.deletedAt).toBeNull()
  })

  it('refuses to withdraw one that was already approved', async () => {
    const game = await openGame()
    const created = await ask(refUser, game.id, { position: 'center' })
    await decide(scheduler, created.body.request.id, { decision: 'approved' })

    const res = await withdraw(refUser, created.body.request.id)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/take you off the game/i)
  })
})

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

describe('the referee’s board', () => {
  it('separates accepted, awaiting an answer, declined and requested', async () => {
    const all = await futureGames()
    const [a, b, c] = [all[0]!, all[1]!, all[2]!]

    const assign = (gameId: string, position: string) =>
      call<{ orgId: string; gameId: string }>(
        assignOfficial,
        `/api/orgs/${org.id}/games/${gameId}/officials`,
        {
          token: scheduler.token,
          params: { orgId: org.id, gameId },
          body: { refereeId, position, overrideReason: 'Fixture setup for the board test.' },
        },
      )

    const first = await assign(a.id, 'center')
    const second = await assign(b.id, 'center')
    const third = await assign(c.id, 'center')
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201])

    const respond = (gameId: string, assignmentId: string, status: string) =>
      call<{ orgId: string; gameId: string; assignmentId: string }>(
        respondToAssignment,
        `/api/orgs/${org.id}/games/${gameId}/officials/${assignmentId}`,
        {
          token: refUser.token,
          method: 'PATCH',
          params: { orgId: org.id, gameId, assignmentId },
          body: { status },
        },
      )

    expect((await respond(a.id, first.body.assignment.id, 'accepted')).status).toBe(200)
    expect((await respond(c.id, third.body.assignment.id, 'declined')).status).toBe(200)

    // And one they asked for themselves. It has to be on a different day from the
    // three above: a, b and c are a Saturday's worth of fixtures, so a fourth on
    // the same date would trip the daily cap or overlap an existing assignment and
    // the request would be refused for a reason that has nothing to do with what
    // this test is about.
    const takenDates = new Set(
      [a, b, c].map((game) =>
        formatCalendarDate(calendarDateInZone(game.startTime, game.field!.venue.timezone)),
      ),
    )
    const spare = (await futureGames()).find(
      (game) =>
        openPositionsFor(game.officials).length === 3 &&
        !takenDates.has(
          formatCalendarDate(calendarDateInZone(game.startTime, game.field!.venue.timezone)),
        ),
    )
    expect(spare, 'fixture needs an unstaffed game on a later date').toBeDefined()

    const asked = await ask(refUser, spare!.id, { position: 'center' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)

    const result = await board()

    expect(result.accepted.map((entry) => entry.row.id)).toEqual([a.id])
    expect(result.awaitingAnswer.map((entry) => entry.row.id)).toEqual([b.id])
    expect(result.declined.map((entry) => entry.row.id)).toEqual([c.id])
    expect(result.pendingRequests.map((entry) => entry.row?.id)).toEqual([spare!.id])

    // A game they have a stake in is not also offered to them as open — including
    // one they declined. The position is free again for *other* referees, but
    // re-offering it to the person who just turned it down is noise. Their way back
    // is the declined bucket, which is why it stays on the board.
    const openIds = result.openGames.map((entry) => entry.row.id)
    expect(openIds).not.toContain(a.id)
    expect(openIds).not.toContain(b.id)
    expect(openIds).not.toContain(spare!.id)
    expect(openIds).not.toContain(c.id)

    // The recovery path for a mistaken decline: the assignment row still exists,
    // so it can be flipped back rather than requested again from scratch.
    const undo = await respond(c.id, third.body.assignment.id, 'accepted')
    expect(undo.status).toBe(200)
    const after = await board()
    expect(after.accepted.map((entry) => entry.row.id).sort()).toEqual([a.id, c.id].sort())
    expect(after.declined).toHaveLength(0)
  })

  it('offers only games that are short an official', async () => {
    const result = await board()

    expect(result.openGames.length).toBeGreaterThan(0)
    for (const entry of result.openGames) {
      expect(entry.openPositions.length).toBeGreaterThan(0)
      expect(entry.row.startTime.getTime()).toBeGreaterThan(Date.now())
      expect(entry.row.status).not.toBe('cancelled')
    }
  })

  it('labels an ineligible game with its reason rather than hiding it', async () => {
    const game = await openGame()
    await prisma.teamMembership.create({
      data: { teamId: game.homeTeamId, personId: refereePersonId, role: 'coach' },
    })

    const result = await board()
    const entry = result.openGames.find((candidate) => candidate.row.id === game.id)

    expect(entry).toBeDefined()
    expect(entry!.conflicts.map((conflict) => conflict.kind)).toContain(
      'referee_conflict_of_interest',
    )
  })

  it('reads the published snapshot for a referee who cannot see drafts', async () => {
    const versions = await call<{ orgId: string; seasonId: string }>(
      listVersions,
      `/api/orgs/${org.id}/seasons/${season.id}/versions`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id } },
    )
    const versionId = versions.body.versions[0].id
    await call<{ orgId: string; seasonId: string; versionId: string }>(
      publish,
      `/api/orgs/${org.id}/seasons/${season.id}/versions/${versionId}/publish`,
      {
        token: owner.token,
        params: { orgId: org.id, seasonId: season.id, versionId },
        body: {},
      },
    )

    const published = await board(false)
    expect(published.source).toBe('published')
    expect(published.openGames.length).toBeGreaterThan(0)
  })

  it('reports source "none" when nothing is published and drafts are hidden', async () => {
    const result = await board(false)
    expect(result.source).toBe('none')
    expect(result.openGames).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The anti-drift guarantee
// ---------------------------------------------------------------------------

describe('the batch evaluator and the write-time gate agree', () => {
  it('returns the same conflict kinds per game as detectOfficialConflicts', async () => {
    // A spread of states, so the comparison covers more than "no conflicts".
    const all = await futureGames()
    await prisma.teamMembership.create({
      data: { teamId: all[0]!.homeTeamId, personId: refereePersonId, role: 'coach' },
    })
    await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${all[1]!.id}/officials`,
      {
        token: scheduler.token,
        params: { orgId: org.id, gameId: all[1]!.id },
        body: { refereeId, position: 'center', overrideReason: 'Fixture setup.' },
      },
    )
    await prisma.referee.update({ where: { id: refereeId }, data: { maxGamesPerDay: 1 } })

    const schedule = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: true,
    })
    const upcoming = schedule.rows.filter((row) => row.startTime.getTime() > Date.now()).slice(0, 12)
    expect(upcoming.length).toBeGreaterThan(3)

    const batch = await evaluateOpenGames(refereeId, upcoming)

    for (const entry of batch) {
      const authoritative = await detectOfficialConflicts(org.id, entry.row.id, refereeId)
      expect(entry.conflicts.map((c) => c.kind).sort()).toEqual(
        authoritative.map((c) => c.kind).sort(),
      )
      expect(entry.conflicts.map((c) => c.message).sort()).toEqual(
        authoritative.map((c) => c.message).sort(),
      )
    }

    // The fixture has to actually produce conflicts or the assertion above is vacuous.
    expect(batch.some((entry) => entry.conflicts.length > 0)).toBe(true)
  })
})
