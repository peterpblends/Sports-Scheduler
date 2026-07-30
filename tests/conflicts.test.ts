import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  CapturingMailer,
  addTeamMember,
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
  resetDatabase,
  signUp,
  useCapturingMailer,
  type TestUser,
} from './helpers'

import { POST as createGame } from '@/app/api/orgs/[orgId]/games/route'
import { PATCH as patchGame } from '@/app/api/orgs/[orgId]/games/[gameId]/route'
import { POST as assignOfficial } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/route'
import { PATCH as patchAssignment } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/[assignmentId]/route'
import { POST as addAvailability } from '@/app/api/orgs/[orgId]/referees/[refereeId]/availability/route'
import { POST as createBlackout } from '@/app/api/orgs/[orgId]/blackouts/route'
import { POST as addRelationship } from '@/app/api/orgs/[orgId]/people/[personId]/relationships/route'

/**
 * Hard constraints, checked one placement at a time. These are the rules the
 * phase 3 generator must never violate and the phase 5 calendar warns about on
 * drop, so they live in one place and are tested directly.
 */

let mailer: CapturingMailer
let owner: TestUser
let org: { id: string }
let division: { id: string }
let teams: { id: string; name: string }[]
let venue: { id: string }
let fieldOne: { id: string }
let fieldTwo: { id: string }

// A Saturday, 9am Pacific.
const SAT_9AM = '2026-04-11T16:00:00.000Z'
const SAT_10AM = '2026-04-11T17:00:00.000Z'

async function makeGame(
  body: Record<string, unknown>,
  token = owner.token,
): Promise<{ status: number; body: any }> {
  return call<{ orgId: string }>(createGame, `/api/orgs/${org.id}/games`, {
    token,
    params: { orgId: org.id },
    body,
  })
}

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()
  owner = await signUp('owner@example.com')
  org = await createOrganization(owner)

  const league = await createLeague(owner, org.id)
  const season = await createSeason(owner, org.id, league.id, {
    startDate: '2026-03-07',
    endDate: '2026-06-13',
  })
  division = await createDivision(owner, org.id, season.id)

  teams = []
  for (const name of ['Rovers', 'Owls', 'Falcons', 'Bears']) {
    teams.push(await createTeam(owner, org.id, division.id, name))
  }

  venue = await createVenue(owner, org.id, 'Riverside Park', 'America/Los_Angeles')
  fieldOne = await createField(owner, org.id, venue.id, 'Field 1')
  fieldTwo = await createField(owner, org.id, venue.id, 'Field 2')

  // Saturdays 8am - 6pm local, for the season window.
  for (const field of [fieldOne, fieldTwo]) {
    await createRecurringSlot(owner, org.id, field.id, {
      dayOfWeek: 6,
      startTime: '08:00',
      endTime: '18:00',
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-06-15',
    })
  }
})

describe('field double-booking', () => {
  it('accepts a first game and refuses an overlapping one on the same field', async () => {
    const first = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(first.status).toBe(201)
    expect(first.body.conflicts).toEqual([])

    const clash = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(clash.status).toBe(409)
    expect(clash.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'field_double_booked',
    )
    expect(await prisma.game.count()).toBe(1)
  })

  it('allows the same time on a different field', async () => {
    await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    const other = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldTwo.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(other.status).toBe(201)
  })

  it('allows back-to-back games that do not overlap', async () => {
    await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    const next = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_10AM,
      durationMinutes: 60,
    })
    expect(next.status).toBe(201)
  })

  it('frees the slot when the first game is cancelled', async () => {
    const first = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${first.body.game.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, gameId: first.body.game.id },
        body: { status: 'cancelled' },
      },
    )

    const replacement = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(replacement.status).toBe(201)
  })
})

describe('team double-booking', () => {
  it('refuses to put one team in two overlapping games', async () => {
    await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    const clash = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id, // already playing
      awayTeamId: teams[2]!.id,
      fieldId: fieldTwo.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    expect(clash.status).toBe(409)
    expect(clash.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'team_double_booked',
    )
  })

  it('refuses a team playing itself', async () => {
    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[0]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(res.status).toBe(400)
  })
})

describe('field availability windows', () => {
  it('refuses a game outside the field’s local availability', async () => {
    // 7am Pacific — an hour before the field opens.
    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: '2026-04-11T14:00:00.000Z',
      durationMinutes: 60,
    })
    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'outside_field_availability',
    )
  })

  it('refuses a game on the wrong day of the week', async () => {
    // Sunday 9am Pacific; slots are Saturdays only.
    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: '2026-04-12T16:00:00.000Z',
      durationMinutes: 60,
    })
    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'outside_field_availability',
    )
  })

  it('refuses a game that would run past closing time', async () => {
    // 5:30pm local start, 60 minutes long, field closes at 6pm.
    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: '2026-04-12T00:30:00.000Z',
      durationMinutes: 60,
    })
    expect(res.status).toBe(409)
  })

  /** The DST case: the same local hour resolves to a different UTC instant. */
  it('judges availability by local time on both sides of a DST change', async () => {
    // 9am PST on Mar 7 is 17:00Z; 9am PDT on Mar 14 is 16:00Z. Both are inside the
    // 8am-6pm local window, so both must be accepted.
    const beforeDst = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: '2026-03-07T17:00:00.000Z',
      durationMinutes: 60,
    })
    expect(beforeDst.status).toBe(201)

    const afterDst = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: '2026-03-14T16:00:00.000Z',
      durationMinutes: 60,
    })
    expect(afterDst.status).toBe(201)

    // And the naive reading — same UTC hour, ignoring DST — is out of bounds on the
    // other side of the change: 17:00Z on Mar 14 is 10am local, still fine, but
    // 16:00Z on Mar 7 is 8am local, so try the boundary that actually fails.
    const tooEarly = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldTwo.id,
      startTime: '2026-03-07T15:00:00.000Z', // 7am PST
      durationMinutes: 60,
    })
    expect(tooEarly.status).toBe(409)
  })

  it('treats a field with no declared slots as unconstrained', async () => {
    const bareVenue = await createVenue(owner, org.id, 'Bare Park', 'America/Los_Angeles')
    const bareField = await createField(owner, org.id, bareVenue.id, 'Anytime Field')

    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: bareField.id,
      startTime: '2026-04-13T11:00:00.000Z', // Monday 4am local
      durationMinutes: 60,
    })
    expect(res.status).toBe(201)
  })
})

describe('blackout dates', () => {
  it('blocks a game on an org-wide blackout', async () => {
    await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { scope: 'org', startDate: '2026-04-11', endDate: '2026-04-11', reason: 'Easter weekend' },
    })

    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(res.status).toBe(409)
    const conflict = res.body.details.conflicts.find((c: { kind: string }) => c.kind === 'blackout_date')
    expect(conflict.message).toContain('Easter weekend')
  })

  it('blocks only the affected team for a team-scoped blackout', async () => {
    await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        scope: 'team',
        teamId: teams[0]!.id,
        startDate: '2026-04-11',
        endDate: '2026-04-11',
        reason: 'Tournament',
      },
    })

    const blocked = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(blocked.status).toBe(409)

    const allowed = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(allowed.status).toBe(201)
  })

  it('judges a blackout by the venue’s local date, not the UTC date', async () => {
    // 8pm Pacific Apr 11 is already Apr 12 in UTC. A blackout on Apr 11 must catch it.
    await createRecurringSlot(owner, org.id, fieldOne.id, {
      dayOfWeek: 6,
      startTime: '18:00',
      endTime: '22:00',
    })
    await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { scope: 'org', startDate: '2026-04-11', endDate: '2026-04-11', reason: 'Local holiday' },
    })

    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: '2026-04-12T03:00:00.000Z', // 8pm PDT on Apr 11
      durationMinutes: 60,
    })
    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain('blackout_date')
  })
})

/** Acceptance scenario 4, at the API level: conflict warning then logged override. */
describe('override with a required reason', () => {
  it('refuses without a reason, proceeds with one, and logs it', async () => {
    const first = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(first.status).toBe(201)

    const refused = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(refused.status).toBe(409)

    const overridden = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
      overrideReason: 'Field splits into two half-pitches for U8s.',
    })
    expect(overridden.status).toBe(201)
    expect(overridden.body.conflicts.length).toBeGreaterThan(0)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Game', entityId: overridden.body.game.id, action: 'game.created' },
    })
    const meta = event.meta as { overrideReason?: string; overriddenConflicts?: unknown[] }
    expect(meta.overrideReason).toBe('Field splits into two half-pitches for U8s.')
    expect(meta.overriddenConflicts).toHaveLength(1)
  })

  it('rejects a reason that is too short to be meaningful', async () => {
    await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    const res = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
      overrideReason: 'x',
    })
    expect(res.status).toBe(400)
  })

  it('applies the same rule when moving an existing game onto an occupied slot', async () => {
    const occupied = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    const mover = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldTwo.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    expect(occupied.status).toBe(201)

    const gameId = mover.body.game.id
    const refused = await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${gameId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, gameId },
        body: { fieldId: fieldOne.id },
      },
    )
    expect(refused.status).toBe(409)
    expect(refused.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'field_double_booked',
    )

    const moved = await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${gameId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, gameId },
        body: { fieldId: fieldOne.id, overrideReason: 'Field 2 flooded; sharing Field 1.' },
      },
    )
    expect(moved.status).toBe(200)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Game', entityId: gameId, action: 'game.moved' },
    })
    expect((event.meta as { overrideReason?: string }).overrideReason).toBe(
      'Field 2 flooded; sharing Field 1.',
    )
    expect(event.diff).toHaveProperty('fieldId')
  })

  it('does not re-check placement for a score-only edit', async () => {
    const game = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    const res = await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${game.body.game.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, gameId: game.body.game.id },
        body: { homeScore: 3, awayScore: 1 },
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.conflicts).toEqual([])
  })
})

/** Acceptance scenario 3, at the API level. */
describe('officiating constraints', () => {
  let gameId: string
  let refereeId: string
  let refPersonId: string

  beforeEach(async () => {
    const game = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    gameId = game.body.game.id

    const person = await createPerson(owner, org.id, 'Wei Chen')
    refPersonId = person.id
    const referee = await createReferee(owner, org.id, person.id, {
      payRateCents: 4500,
      maxGamesPerDay: 2,
    })
    refereeId = referee.id
  })

  async function assign(body: Record<string, unknown>, token = owner.token) {
    return call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${gameId}/officials`,
      { token, params: { orgId: org.id, gameId }, body },
    )
  }

  it('assigns an official with no conflicts', async () => {
    const res = await assign({ refereeId, position: 'center' })
    expect(res.status).toBe(201)
    expect(res.body.conflicts).toEqual([])
    expect(res.body.assignment.status).toBe('pending')
  })

  it('refuses two officials in the same position', async () => {
    await assign({ refereeId, position: 'center' })

    const second = await createPerson(owner, org.id, 'Second Ref')
    const secondRef = await createReferee(owner, org.id, second.id)

    const res = await assign({ refereeId: secondRef.id, position: 'center' })
    expect(res.status).toBe(409)
  })

  it('refuses an official who is a member of one of the teams', async () => {
    await addTeamMember(owner, org.id, teams[0]!.id, refPersonId, 'coach')

    const res = await assign({ refereeId, position: 'center' })
    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'referee_conflict_of_interest',
    )
  })

  it('refuses an official related to someone on one of the teams', async () => {
    const child = await createPerson(owner, org.id, 'Ref Child')
    await addTeamMember(owner, org.id, teams[1]!.id, child.id, 'player')

    await call<{ orgId: string; personId: string }>(
      addRelationship,
      `/api/orgs/${org.id}/people/${refPersonId}/relationships`,
      {
        token: owner.token,
        params: { orgId: org.id, personId: refPersonId },
        body: { relatedPersonId: child.id, kind: 'family' },
      },
    )

    const res = await assign({ refereeId, position: 'center' })
    expect(res.status).toBe(409)
    const conflict = res.body.details.conflicts.find(
      (c: { kind: string }) => c.kind === 'referee_conflict_of_interest',
    )
    expect(conflict.message).toContain('related to')
  })

  it('refuses an official who is blacked out that day', async () => {
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${refereeId}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId },
        body: { kind: 'blackout', startDate: '2026-04-10', endDate: '2026-04-12', reason: 'Away' },
      },
    )

    const res = await assign({ refereeId, position: 'center' })
    expect(res.status).toBe(409)
    const conflict = res.body.details.conflicts.find(
      (c: { kind: string }) => c.kind === 'referee_unavailable',
    )
    expect(conflict.message).toContain('Away')
  })

  it('refuses an official outside their declared weekly window', async () => {
    // Available Saturdays 1pm - 5pm local; the game is at 9am.
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${refereeId}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '13:00', endTime: '17:00' },
      },
    )

    const res = await assign({ refereeId, position: 'center' })
    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'referee_unavailable',
    )
  })

  it('accepts an official inside their declared weekly window', async () => {
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${refereeId}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '12:00' },
      },
    )

    const res = await assign({ refereeId, position: 'center' })
    expect(res.status).toBe(201)
  })

  it('enforces the daily cap, counted in the venue’s local day', async () => {
    await assign({ refereeId, position: 'center' })

    // Two more games the same local Saturday; the cap is 2.
    const later = ['2026-04-11T18:00:00.000Z', '2026-04-11T20:00:00.000Z']
    const extraGameIds: string[] = []
    for (const [index, startTime] of later.entries()) {
      const game = await makeGame({
        divisionId: division.id,
        homeTeamId: teams[2]!.id,
        awayTeamId: teams[3]!.id,
        fieldId: index === 0 ? fieldOne.id : fieldTwo.id,
        startTime,
        durationMinutes: 60,
      })
      expect(game.status).toBe(201)
      extraGameIds.push(game.body.game.id)
    }

    const second = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${extraGameIds[0]}/officials`,
      {
        token: owner.token,
        params: { orgId: org.id, gameId: extraGameIds[0]! },
        body: { refereeId, position: 'center' },
      },
    )
    expect(second.status).toBe(201)

    const third = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${extraGameIds[1]}/officials`,
      {
        token: owner.token,
        params: { orgId: org.id, gameId: extraGameIds[1]! },
        body: { refereeId, position: 'center' },
      },
    )
    expect(third.status).toBe(409)
    expect(third.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'referee_daily_cap',
    )
  })

  it('refuses an overlapping assignment for the same official', async () => {
    await assign({ refereeId, position: 'center' })

    const overlapping = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[2]!.id,
      awayTeamId: teams[3]!.id,
      fieldId: fieldTwo.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })

    const res = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${overlapping.body.game.id}/officials`,
      {
        token: owner.token,
        params: { orgId: org.id, gameId: overlapping.body.game.id },
        body: { refereeId, position: 'center' },
      },
    )
    expect(res.status).toBe(409)
    expect(res.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'referee_unavailable',
    )
  })

  it('logs an override when an assigner overrules a conflict of interest', async () => {
    await addTeamMember(owner, org.id, teams[0]!.id, refPersonId, 'coach')

    const res = await assign({
      refereeId,
      position: 'center',
      overrideReason: 'No other certified official available; both coaches agreed.',
    })
    expect(res.status).toBe(201)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'GameOfficial', action: 'official.assigned' },
    })
    const meta = event.meta as { overrideReason?: string; overriddenConflicts?: { kind: string }[] }
    expect(meta.overrideReason).toContain('No other certified official')
    expect(meta.overriddenConflicts?.[0]?.kind).toBe('referee_conflict_of_interest')
  })
})

describe('referees responding to their own assignments', () => {
  it('lets a referee accept their own assignment but not another’s, and never set pay', async () => {
    const { inviteAndAccept } = await import('./helpers')
    const refUser = await inviteAndAccept(owner, org.id, 'ref@example.com', 'referee', mailer)
    const refPerson = await createPerson(owner, org.id, 'Self Ref', { userId: refUser.id })
    const mine = await createReferee(owner, org.id, refPerson.id)

    const otherPerson = await createPerson(owner, org.id, 'Other Ref')
    const other = await createReferee(owner, org.id, otherPerson.id)

    const game = await makeGame({
      divisionId: division.id,
      homeTeamId: teams[0]!.id,
      awayTeamId: teams[1]!.id,
      fieldId: fieldOne.id,
      startTime: SAT_9AM,
      durationMinutes: 60,
    })
    const gameId = game.body.game.id

    const mineAssignment = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${gameId}/officials`,
      {
        token: owner.token,
        params: { orgId: org.id, gameId },
        body: { refereeId: mine.id, position: 'center' },
      },
    )
    const otherAssignment = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${gameId}/officials`,
      {
        token: owner.token,
        params: { orgId: org.id, gameId },
        body: { refereeId: other.id, position: 'AR1' },
      },
    )

    const accepted = await call<{ orgId: string; gameId: string; assignmentId: string }>(
      patchAssignment,
      `/api/orgs/${org.id}/games/${gameId}/officials/${mineAssignment.body.assignment.id}`,
      {
        method: 'PATCH',
        token: refUser.token,
        params: { orgId: org.id, gameId, assignmentId: mineAssignment.body.assignment.id },
        body: { status: 'accepted' },
      },
    )
    expect(accepted.status).toBe(200)
    expect(accepted.body.assignment.status).toBe('accepted')
    expect(accepted.body.assignment.respondedAt).not.toBeNull()

    const notMine = await call<{ orgId: string; gameId: string; assignmentId: string }>(
      patchAssignment,
      `/api/orgs/${org.id}/games/${gameId}/officials/${otherAssignment.body.assignment.id}`,
      {
        method: 'PATCH',
        token: refUser.token,
        params: { orgId: org.id, gameId, assignmentId: otherAssignment.body.assignment.id },
        body: { status: 'declined' },
      },
    )
    expect(notMine.status).toBe(403)

    const payGrab = await call<{ orgId: string; gameId: string; assignmentId: string }>(
      patchAssignment,
      `/api/orgs/${org.id}/games/${gameId}/officials/${mineAssignment.body.assignment.id}`,
      {
        method: 'PATCH',
        token: refUser.token,
        params: { orgId: org.id, gameId, assignmentId: mineAssignment.body.assignment.id },
        body: { payRateCentsOverride: 100_000 },
      },
    )
    expect(payGrab.status).toBe(403)
  })
})
