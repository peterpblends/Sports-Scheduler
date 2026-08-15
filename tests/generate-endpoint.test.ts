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
  inviteAndAccept,
  resetDatabase,
  signUp,
  useCapturingMailer,
  type TestUser,
} from './helpers'

import { POST as generate } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/generate/route'
import { POST as addAvailability } from '@/app/api/orgs/[orgId]/referees/[refereeId]/availability/route'
import { POST as createBlackout } from '@/app/api/orgs/[orgId]/blackouts/route'

/**
 * End-to-end generation: the database adapter, the engine, and the commit path.
 *
 * The engine itself is covered by `scheduler.test.ts` against fixtures. What matters
 * here is that real rows load into the engine correctly, that a dry run writes
 * nothing, and that committing preserves played games and retires the rest into
 * history rather than deleting them.
 */

let mailer: CapturingMailer
let owner: TestUser
let org: { id: string; slug: string }
let season: { id: string }
let divisionId: string
let teamIds: string[]

async function runGenerate(
  actor: TestUser,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return call<{ orgId: string; seasonId: string }>(
    generate,
    `/api/orgs/${org.id}/seasons/${season.id}/generate`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id }, body },
  )
}

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()
  owner = await signUp('owner@example.com')
  org = await createOrganization(owner)

  const league = await createLeague(owner, org.id, 'Recreational')
  season = await createSeason(owner, org.id, league.id, {
    name: 'Spring 2026',
    startDate: '2026-03-07',
    endDate: '2026-05-23',
  })
  const division = await createDivision(owner, org.id, season.id, 'U12 Boys')
  divisionId = division.id

  teamIds = []
  for (const name of ['Rovers', 'Owls', 'Breakers', 'Falcons', 'United', 'Nomads']) {
    const team = await createTeam(owner, org.id, divisionId, name)
    teamIds.push(team.id)
  }

  // Two venues, three fields, Saturdays 8am-6pm local.
  const riverside = await createVenue(owner, org.id, 'Riverside Park')
  const eastside = await createVenue(owner, org.id, 'Eastside Complex')
  for (const [venue, names] of [
    [riverside, ['Field 1', 'Field 2']],
    [eastside, ['Turf A']],
  ] as const) {
    for (const name of names) {
      const field = await createField(owner, org.id, venue.id, name)
      await createRecurringSlot(owner, org.id, field.id, {
        dayOfWeek: 6,
        startTime: '08:00',
        endTime: '18:00',
        effectiveFrom: '2026-03-01',
        effectiveTo: '2026-05-30',
      })
    }
  }
})

describe('authorization', () => {
  it('requires schedule:generate', async () => {
    const viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)

    for (const actor of [viewer, coach]) {
      const res = await runGenerate(actor, { commit: false })
      expect(res.status, actor.email).toBe(403)
    }
    expect(await prisma.game.count()).toBe(0)
  })

  it('lets a scheduler generate and commit', async () => {
    const scheduler = await inviteAndAccept(owner, org.id, 'sched@example.com', 'scheduler', mailer)
    const res = await runGenerate(scheduler, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    expect(res.status).toBe(200)
    expect(res.body.committed).toBe(true)
    expect(await prisma.game.count({ where: { deletedAt: null } })).toBeGreaterThan(0)
  })

  it('refuses a season from another org', async () => {
    const outsider = await signUp('outsider@example.com')
    const otherOrg = await createOrganization(outsider, 'Rival')
    const otherLeague = await createLeague(outsider, otherOrg.id)
    const otherSeason = await createSeason(outsider, otherOrg.id, otherLeague.id)

    const res = await call<{ orgId: string; seasonId: string }>(
      generate,
      `/api/orgs/${org.id}/seasons/${otherSeason.id}/generate`,
      {
        token: owner.token,
        params: { orgId: org.id, seasonId: otherSeason.id },
        body: { commit: false },
      },
    )
    expect(res.status).toBe(404)
  })
})

describe('dry run', () => {
  it('returns a schedule and a report without writing anything', async () => {
    const res = await runGenerate(owner, { commit: false, config: { seed: 5, roundRobinTimes: 1 } })

    expect(res.status).toBe(200)
    expect(res.body.committed).toBe(false)
    // 6 teams single round robin = 15 games.
    expect(res.body.report.counts.placed).toBe(15)
    expect(res.body.preview).toHaveLength(15)

    // Nothing persisted, and no audit event for a generation that did not happen.
    expect(await prisma.game.count()).toBe(0)
    expect(await prisma.auditEvent.count({ where: { action: 'schedule.generated' } })).toBe(0)
  })

  it('renders kickoffs in the venue’s local time', async () => {
    const res = await runGenerate(owner, { commit: false, config: { seed: 5, roundRobinTimes: 1 } })
    for (const game of res.body.preview) {
      expect(game.localStartTime).toMatch(/[AP]M P[DS]T$/)
      expect(game.venue).toBeTruthy()
      expect(game.field).toBeTruthy()
    }
  })

  it('refuses when a division has fewer than two teams', async () => {
    await resetDatabase()
    owner = await signUp('solo@example.com')
    org = await createOrganization(owner)
    const league = await createLeague(owner, org.id)
    season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id)
    await createTeam(owner, org.id, division.id, 'Only')

    const res = await runGenerate(owner, { commit: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('at least two teams')
  })

  it('refuses to regenerate an archived season', async () => {
    await prisma.season.update({ where: { id: season.id }, data: { status: 'archived' } })
    const res = await runGenerate(owner, { commit: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('archived')
  })
})

describe('commit', () => {
  it('writes games, assignments and one audit event', async () => {
    const person = await createPerson(owner, org.id, 'Wei Chen')
    const referee = await createReferee(owner, org.id, person.id, { payRateCents: 4500 })
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${referee.id}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId: referee.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '18:00' },
      },
    )

    const res = await runGenerate(owner, {
      commit: true,
      note: 'first cut',
      config: {
        seed: 3,
        roundRobinTimes: 1,
        officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
      },
    })

    expect(res.status).toBe(200)
    expect(res.body.written.created).toBe(15)

    const games = await prisma.game.findMany({ where: { deletedAt: null } })
    expect(games).toHaveLength(15)
    for (const game of games) {
      expect(game.status).toBe('scheduled')
      expect(game.fieldId).not.toBeNull()
      expect(game.roundNumber).not.toBeNull()
    }

    const assignments = await prisma.gameOfficial.findMany({ where: { deletedAt: null } })
    expect(assignments.length).toBeGreaterThan(0)
    expect(assignments.length).toBe(res.body.written.assignments)

    const events = await prisma.auditEvent.findMany({ where: { action: 'schedule.generated' } })
    expect(events).toHaveLength(1)
    const meta = events[0]!.meta as Record<string, unknown>
    expect(meta.seed).toBe(3)
    expect(meta.note).toBe('first cut')
    expect(meta.config).toBeTruthy()
    expect(meta.counts).toBeTruthy()
  })

  it('retires the previous schedule into history rather than deleting it', async () => {
    await runGenerate(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const firstIds = (await prisma.game.findMany({ where: { deletedAt: null } })).map((g) => g.id)
    expect(firstIds).toHaveLength(15)

    const second = await runGenerate(owner, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })
    expect(second.body.written.retired).toBe(15)

    // The old rows are still there, soft-deleted.
    const retired = await prisma.game.findMany({ where: { id: { in: firstIds } } })
    expect(retired).toHaveLength(15)
    for (const game of retired) expect(game.deletedAt).not.toBeNull()

    // And exactly one live schedule remains.
    expect(await prisma.game.count({ where: { deletedAt: null } })).toBe(15)
    expect(await prisma.auditEvent.count({ where: { action: 'schedule.generated' } })).toBe(2)
  })

  it('soft-deletes the officials attached to a retired schedule', async () => {
    const person = await createPerson(owner, org.id, 'Wei Chen')
    const referee = await createReferee(owner, org.id, person.id)
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${referee.id}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId: referee.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '18:00' },
      },
    )

    const config = {
      seed: 1,
      roundRobinTimes: 1,
      officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
    }
    await runGenerate(owner, { commit: true, config })
    const firstAssignmentIds = (await prisma.gameOfficial.findMany({ where: { deletedAt: null } })).map(
      (a) => a.id,
    )
    expect(firstAssignmentIds.length).toBeGreaterThan(0)

    await runGenerate(owner, { commit: true, config: { ...config, seed: 2 } })

    const retired = await prisma.gameOfficial.findMany({ where: { id: { in: firstAssignmentIds } } })
    for (const assignment of retired) expect(assignment.deletedAt).not.toBeNull()
  })

  it('produces the same schedule twice for the same seed', async () => {
    const first = await runGenerate(owner, { commit: false, config: { seed: 77, roundRobinTimes: 1 } })
    const second = await runGenerate(owner, { commit: false, config: { seed: 77, roundRobinTimes: 1 } })

    const signature = (res: { body: any }) =>
      res.body.preview
        .map((g: any) => `${g.roundNumber}|${g.homeTeam}|${g.awayTeam}|${g.field}|${g.startTime}`)
        .join('\n')

    expect(signature(first)).toBe(signature(second))
  })
})

describe('regeneration preserves played games', () => {
  it('leaves played games alone and schedules around them', async () => {
    await runGenerate(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    // Mark the four earliest games as played, with results.
    const earliest = await prisma.game.findMany({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
      take: 4,
    })
    for (const [index, game] of earliest.entries()) {
      await prisma.game.update({
        where: { id: game.id },
        data: { status: 'played', homeScore: index % 3, awayScore: (index + 1) % 3 },
      })
    }
    const playedIds = earliest.map((g) => g.id)

    const res = await runGenerate(owner, { commit: true, config: { seed: 500, roundRobinTimes: 1 } })
    expect(res.status).toBe(200)
    expect(res.body.report.counts.preserved).toBe(4)

    // Untouched: same id, same slot, still played, results intact.
    const preserved = await prisma.game.findMany({ where: { id: { in: playedIds } } })
    expect(preserved).toHaveLength(4)
    for (const game of preserved) {
      const original = earliest.find((g) => g.id === game.id)!
      expect(game.deletedAt).toBeNull()
      expect(game.status).toBe('played')
      expect(game.startTime.toISOString()).toBe(original.startTime.toISOString())
      expect(game.fieldId).toBe(original.fieldId)
      expect(game.homeScore).not.toBeNull()
    }

    // And nothing new was placed on top of them.
    const occupied = new Set(preserved.map((g) => `${g.fieldId}|${g.startTime.getTime()}`))
    const fresh = await prisma.game.findMany({
      where: { deletedAt: null, id: { notIn: playedIds } },
    })
    for (const game of fresh) {
      expect(occupied.has(`${game.fieldId}|${game.startTime.getTime()}`)).toBe(false)
    }
  })

  it('does not preserve merely scheduled games', async () => {
    await runGenerate(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const res = await runGenerate(owner, { commit: false, config: { seed: 2, roundRobinTimes: 1 } })
    expect(res.body.report.counts.preserved).toBe(0)
  })

  it('honours a wider preserveStatuses list', async () => {
    await runGenerate(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const confirmed = await prisma.game.findMany({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
      take: 3,
    })
    await prisma.game.updateMany({
      where: { id: { in: confirmed.map((g) => g.id) } },
      data: { status: 'confirmed' },
    })

    const res = await runGenerate(owner, {
      commit: false,
      config: { seed: 9, roundRobinTimes: 1, preserveStatuses: ['played', 'confirmed'] },
    })
    expect(res.body.report.counts.preserved).toBe(3)
  })
})

describe('real entities feed the engine', () => {
  it('respects a blackout stored in the database', async () => {
    await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        scope: 'org',
        startDate: '2026-03-07',
        endDate: '2026-03-21',
        reason: 'Spring break',
      },
    })

    const res = await runGenerate(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    expect(res.status).toBe(200)

    const games = await prisma.game.findMany({ where: { deletedAt: null } })
    expect(games.length).toBeGreaterThan(0)
    for (const game of games) {
      // 2026-03-21 in Pacific ends at 2026-03-22T07:00Z.
      expect(game.startTime.getTime()).toBeGreaterThan(new Date('2026-03-22T07:00:00Z').getTime())
    }
  })

  it('keeps an official off games involving a team they are on', async () => {
    const person = await createPerson(owner, org.id, 'Coach Referee')
    await addTeamMember(owner, org.id, teamIds[0]!, person.id, 'coach')
    const referee = await createReferee(owner, org.id, person.id)
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${referee.id}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId: referee.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '18:00' },
      },
    )

    await runGenerate(owner, {
      commit: true,
      config: {
        seed: 1,
        roundRobinTimes: 1,
        officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
      },
    })

    const assignments = await prisma.gameOfficial.findMany({
      where: { deletedAt: null, refereeId: referee.id },
      include: { game: true },
    })
    for (const assignment of assignments) {
      expect([assignment.game.homeTeamId, assignment.game.awayTeamId]).not.toContain(teamIds[0])
    }
  })

  it('keeps an official off games involving a relative’s team', async () => {
    const official = await createPerson(owner, org.id, 'Parent Official')
    const child = await createPerson(owner, org.id, 'Their Child')
    await addTeamMember(owner, org.id, teamIds[1]!, child.id, 'player')

    const { POST: addRelationship } = await import(
      '@/app/api/orgs/[orgId]/people/[personId]/relationships/route'
    )
    await call<{ orgId: string; personId: string }>(
      addRelationship,
      `/api/orgs/${org.id}/people/${official.id}/relationships`,
      {
        token: owner.token,
        params: { orgId: org.id, personId: official.id },
        body: { relatedPersonId: child.id, kind: 'family' },
      },
    )

    const referee = await createReferee(owner, org.id, official.id)
    await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${referee.id}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId: referee.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '18:00' },
      },
    )

    await runGenerate(owner, {
      commit: true,
      config: {
        seed: 1,
        roundRobinTimes: 1,
        officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
      },
    })

    const assignments = await prisma.gameOfficial.findMany({
      where: { deletedAt: null, refereeId: referee.id },
      include: { game: true },
    })
    for (const assignment of assignments) {
      expect([assignment.game.homeTeamId, assignment.game.awayTeamId]).not.toContain(teamIds[1])
    }
  })

  it('does not double-book a field across divisions sharing the venues', async () => {
    const second = await createDivision(owner, org.id, season.id, 'U10 Girls')
    for (const name of ['Lions', 'Foxes', 'Bees', 'Gulls']) {
      await createTeam(owner, org.id, second.id, name)
    }

    await runGenerate(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    const games = await prisma.game.findMany({ where: { deletedAt: null } })
    const seen = new Set<string>()
    for (const game of games) {
      const key = `${game.fieldId}|${game.startTime.getTime()}`
      expect(seen.has(key), `field reused at ${key}`).toBe(false)
      seen.add(key)
    }
    // Both divisions were scheduled.
    expect(new Set(games.map((g) => g.divisionId)).size).toBe(2)
  })
})
