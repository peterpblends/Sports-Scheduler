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
import { PATCH as patchGame } from '@/app/api/orgs/[orgId]/games/[gameId]/route'
import { POST as assignOfficial } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/route'
import { GET as officialCandidates } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/candidates/route'
import { POST as importRoster } from '@/app/api/orgs/[orgId]/teams/[teamId]/import/route'
import { POST as publish } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/[versionId]/publish/route'
import { GET as listVersions, POST as saveVersion } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/route'
import { GET as getStandings } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/standings/route'

import { parseCsv, parseRosterCsv, toCsv } from '@/lib/csv'
import { buildScheduleGrid } from '@/lib/schedule/grid'
import { groupByLocalDate, readSchedule, type ScheduleRow } from '@/lib/schedule/read'

/**
 * Phase 5: the editing UI's server side.
 *
 * Acceptance scenario 4 lives here — drag a game onto an occupied slot, get a warning
 * naming the constraint, override with a reason, and find the reason in the audit
 * trail. The drag itself is a browser gesture; everything that makes it safe is the
 * endpoint underneath it, which is what these test.
 */

let mailer: CapturingMailer
let owner: TestUser
let org: { id: string; slug: string }
let season: { id: string }
let division: { id: string }
let teamIds: string[]
let fieldIds: string[]
let venueId: string

const gen = (actor: TestUser, body: Record<string, unknown>) =>
  call<{ orgId: string; seasonId: string }>(
    generate,
    `/api/orgs/${org.id}/seasons/${season.id}/generate`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id }, body },
  )

const patch = (actor: TestUser, gameId: string, body: Record<string, unknown>) =>
  call<{ orgId: string; gameId: string }>(patchGame, `/api/orgs/${org.id}/games/${gameId}`, {
    token: actor.token,
    method: 'PATCH',
    params: { orgId: org.id, gameId },
    body,
  })

const games = () =>
  prisma.game.findMany({
    where: { deletedAt: null },
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    include: { field: { include: { venue: true } } },
  })

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
  division = await createDivision(owner, org.id, season.id, 'U12 Boys')

  teamIds = []
  for (const name of ['Rovers', 'Owls', 'Breakers', 'Falcons']) {
    const team = await createTeam(owner, org.id, division.id, name)
    teamIds.push(team.id)
  }

  const venue = await createVenue(owner, org.id, 'Riverside Park')
  venueId = venue.id
  fieldIds = []
  for (const name of ['Field 1', 'Field 2']) {
    const field = await createField(owner, org.id, venue.id, name)
    fieldIds.push(field.id)
    await createRecurringSlot(owner, org.id, field.id, {
      dayOfWeek: 6,
      startTime: '08:00',
      endTime: '18:00',
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-05-30',
    })
  }
})

// ---------------------------------------------------------------------------
// Acceptance scenario 4
// ---------------------------------------------------------------------------

describe('acceptance scenario 4: drag onto an occupied slot', () => {
  it('refuses the move, names the constraint, then accepts it with a reason', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    const all = await games()
    expect(all.length).toBeGreaterThanOrEqual(2)

    // Two games that are not already on the same field at the same time.
    const target = all[0]!
    const dragged = all.find(
      (game) =>
        game.id !== target.id &&
        !(game.fieldId === target.fieldId && game.startTime.getTime() === target.startTime.getTime()),
    )!

    // --- the drop: same field, same instant as a game that is already there
    const refused = await patch(owner, dragged.id, {
      fieldId: target.fieldId,
      startTime: target.startTime.toISOString(),
    })

    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/hard constraint/i)
    const kinds = (refused.body.details.conflicts as Array<{ kind: string; message: string }>).map(
      (conflict) => conflict.kind,
    )
    expect(kinds).toContain('field_double_booked')
    // The message has to be readable, not just a code — it is what the operator sees.
    for (const conflict of refused.body.details.conflicts) {
      expect(conflict.message.length).toBeGreaterThan(10)
    }

    // --- nothing moved
    const unchanged = await prisma.game.findUniqueOrThrow({ where: { id: dragged.id } })
    expect(unchanged.startTime.toISOString()).toBe(dragged.startTime.toISOString())
    expect(unchanged.fieldId).toBe(dragged.fieldId)

    // --- override with a reason
    const reason = 'Both clubs agreed to share the field for a doubleheader'
    const accepted = await patch(owner, dragged.id, {
      fieldId: target.fieldId,
      startTime: target.startTime.toISOString(),
      overrideReason: reason,
    })

    expect(accepted.status).toBe(200)
    const moved = await prisma.game.findUniqueOrThrow({ where: { id: dragged.id } })
    expect(moved.fieldId).toBe(target.fieldId)
    expect(moved.startTime.toISOString()).toBe(target.startTime.toISOString())

    // --- the reason and the conflicts it overrode are both in the trail
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Game', entityId: dragged.id, action: 'game.moved' },
      orderBy: { createdAt: 'desc' },
    })
    const meta = event.meta as Record<string, unknown>
    expect(meta.overrideReason).toBe(reason)
    expect(Array.isArray(meta.overriddenConflicts)).toBe(true)
    expect((meta.overriddenConflicts as Array<{ kind: string }>).map((c) => c.kind)).toContain(
      'field_double_booked',
    )
    // And the before/after is on the record, not just the fact that it moved.
    const diff = event.diff as Record<string, { before: unknown; after: unknown }>
    expect(diff.startTime!.before).toBe(dragged.startTime.toISOString())
    expect(diff.startTime!.after).toBe(target.startTime.toISOString())
  })

  it('rejects an override with no reason even on a second attempt', async () => {
    await gen(owner, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })
    const all = await games()
    const target = all[0]!
    const dragged = all.find((game) => game.id !== target.id)!

    for (const attempt of [1, 2]) {
      const res = await patch(owner, dragged.id, {
        fieldId: target.fieldId,
        startTime: target.startTime.toISOString(),
      })
      expect(res.status, `attempt ${attempt}`).toBe(409)
    }
    // A blank reason is not a reason: the schema requires 3 characters.
    const blank = await patch(owner, dragged.id, {
      fieldId: target.fieldId,
      startTime: target.startTime.toISOString(),
      overrideReason: '  ',
    })
    expect(blank.status).toBe(400)
  })

  it('moves a game to a free slot with no override needed', async () => {
    await gen(owner, { commit: true, config: { seed: 3, roundRobinTimes: 1 } })
    const all = await games()
    const dragged = all[0]!

    // A Saturday inside the season with nothing on it.
    const emptySaturday = new Date('2026-05-16T15:00:00.000Z')
    const res = await patch(owner, dragged.id, {
      fieldId: dragged.fieldId,
      startTime: emptySaturday.toISOString(),
    })

    expect(res.status).toBe(200)
    expect(res.body.conflicts).toEqual([])
    const moved = await prisma.game.findUniqueOrThrow({ where: { id: dragged.id } })
    expect(moved.startTime.toISOString()).toBe(emptySaturday.toISOString())
  })

  it('refuses a move outside the field’s published availability', async () => {
    await gen(owner, { commit: true, config: { seed: 4, roundRobinTimes: 1 } })
    const dragged = (await games())[0]!

    // 3am local on a Saturday: the field is only open 08:00–18:00.
    const res = await patch(owner, dragged.id, {
      fieldId: dragged.fieldId,
      startTime: '2026-05-16T10:00:00.000Z',
    })

    expect(res.status).toBe(409)
    expect(
      (res.body.details.conflicts as Array<{ kind: string }>).map((conflict) => conflict.kind),
    ).toContain('outside_field_availability')
  })

  it('lets a scheduler drag but not a coach or a viewer', async () => {
    await gen(owner, { commit: true, config: { seed: 5, roundRobinTimes: 1 } })
    const dragged = (await games())[0]!
    const free = '2026-05-16T15:00:00.000Z'

    const scheduler = await inviteAndAccept(owner, org.id, 'sched@example.com', 'scheduler', mailer)
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
    const viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)

    expect((await patch(scheduler, dragged.id, { startTime: free })).status).toBe(200)
    for (const actor of [coach, viewer]) {
      const res = await patch(actor, dragged.id, { startTime: '2026-05-23T15:00:00.000Z' })
      expect(res.status, actor.email).toBe(403)
    }
    // And the coach's refused move really did not land.
    const after = await prisma.game.findUniqueOrThrow({ where: { id: dragged.id } })
    expect(after.startTime.toISOString()).toBe(free)
  })
})

// ---------------------------------------------------------------------------
// Local-time editing
// ---------------------------------------------------------------------------

describe('editing a kickoff in local time', () => {
  it('reads localDate and localTime in the target field’s zone', async () => {
    await gen(owner, { commit: true, config: { seed: 6, roundRobinTimes: 1 } })
    const game = (await games())[0]!

    // 9:00 at a Los Angeles venue in May is PDT, UTC-7, so 16:00Z.
    const res = await patch(owner, game.id, {
      localDate: '2026-05-16',
      localTime: '09:00',
      fieldId: game.fieldId,
    })
    expect(res.status).toBe(200)

    const moved = await prisma.game.findUniqueOrThrow({ where: { id: game.id } })
    expect(moved.startTime.toISOString()).toBe('2026-05-16T16:00:00.000Z')
  })

  it('keeps the local time and changes the instant when moving between zones', async () => {
    await gen(owner, { commit: true, config: { seed: 7, roundRobinTimes: 1 } })
    const game = (await games())[0]!

    // A second venue an hour east, with the same Saturday window.
    const denver = await createVenue(owner, org.id, 'Mile High Park', 'America/Denver')
    const denverField = await createField(owner, org.id, denver.id, 'Turf A')
    await createRecurringSlot(owner, org.id, denverField.id, {
      dayOfWeek: 6,
      startTime: '08:00',
      endTime: '18:00',
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-05-30',
    })

    const res = await patch(owner, game.id, {
      localDate: '2026-05-16',
      localTime: '09:00',
      fieldId: denverField.id,
    })
    expect(res.status).toBe(200)

    // 9:00 MDT is UTC-6 → 15:00Z, an hour earlier than the same reading in Pacific.
    const moved = await prisma.game.findUniqueOrThrow({ where: { id: game.id } })
    expect(moved.startTime.toISOString()).toBe('2026-05-16T15:00:00.000Z')
  })

  it('leaves the kickoff alone when only a score is entered', async () => {
    await gen(owner, { commit: true, config: { seed: 8, roundRobinTimes: 1 } })
    const game = (await games())[0]!

    const res = await patch(owner, game.id, { status: 'played', homeScore: 3, awayScore: 1 })
    expect(res.status).toBe(200)

    const after = await prisma.game.findUniqueOrThrow({ where: { id: game.id } })
    expect(after.startTime.toISOString()).toBe(game.startTime.toISOString())
    expect(after.homeScore).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Officiating
// ---------------------------------------------------------------------------

describe('assignment board', () => {
  async function seedOfficials(count = 3) {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const person = await createPerson(owner, org.id, `Official ${index + 1}`)
      const referee = await createReferee(owner, org.id, person.id)
      ids.push(referee.id)
    }
    return ids
  }

  const candidates = (actor: TestUser, gameId: string) =>
    call<{ orgId: string; gameId: string }>(
      officialCandidates,
      `/api/orgs/${org.id}/games/${gameId}/officials/candidates`,
      { token: actor.token, params: { orgId: org.id, gameId } },
    )

  it('returns every official with the reasons any of them cannot take the game', async () => {
    const [refereeId] = await seedOfficials(3)
    await gen(owner, { commit: true, config: { seed: 9, roundRobinTimes: 1, officialsRequired: { center: 0 } } })
    const game = (await games())[0]!

    const res = await candidates(owner, game.id)
    expect(res.status).toBe(200)
    expect(res.body.candidates).toHaveLength(3)
    for (const candidate of res.body.candidates) {
      expect(candidate).toHaveProperty('conflicts')
      expect(candidate).toHaveProperty('gamesThatDay')
      expect(candidate).toHaveProperty('maxGamesPerDay')
    }
    expect(res.body.candidates.map((c: { refereeId: string }) => c.refereeId)).toContain(refereeId)
  })

  it('flags a conflict of interest and only assigns with a reason', async () => {
    await seedOfficials(1)
    // Generated without a crew, so the official is a genuine candidate rather than
    // someone the generator has already placed on this game.
    await gen(owner, {
      commit: true,
      config: { seed: 10, roundRobinTimes: 1, assignOfficials: false },
    })
    const game = (await games())[0]!
    expect(await prisma.gameOfficial.count({ where: { gameId: game.id, deletedAt: null } })).toBe(0)

    // Put the official on one of the two teams playing.
    const referee = await prisma.referee.findFirstOrThrow({ include: { person: true } })
    await prisma.teamMembership.create({
      data: { teamId: game.homeTeamId, personId: referee.personId, role: 'coach' },
    })

    const listed = await candidates(owner, game.id)
    const entry = listed.body.candidates.find(
      (candidate: { refereeId: string }) => candidate.refereeId === referee.id,
    )
    expect(entry.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'referee_conflict_of_interest',
    )

    const assign = (body: Record<string, unknown>) =>
      call<{ orgId: string; gameId: string }>(
        assignOfficial,
        `/api/orgs/${org.id}/games/${game.id}/officials`,
        { token: owner.token, params: { orgId: org.id, gameId: game.id }, body },
      )

    const refused = await assign({ refereeId: referee.id, position: 'center' })
    expect(refused.status).toBe(409)
    expect(
      (refused.body.details.conflicts as Array<{ kind: string }>).map((c) => c.kind),
    ).toContain('referee_conflict_of_interest')
    expect(await prisma.gameOfficial.count({ where: { gameId: game.id, deletedAt: null } })).toBe(0)

    const forced = await assign({
      refereeId: referee.id,
      position: 'center',
      overrideReason: 'No other certified official available and the club was told',
    })
    expect(forced.status).toBe(201)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'GameOfficial', action: 'official.assigned' },
      orderBy: { createdAt: 'desc' },
    })
    const meta = event.meta as Record<string, unknown>
    expect(meta.overrideReason).toMatch(/No other certified official/)
  })

  it('keeps the candidate list away from roles that cannot assign', async () => {
    await seedOfficials(1)
    await gen(owner, { commit: true, config: { seed: 11, roundRobinTimes: 1 } })
    const game = (await games())[0]!

    const coach = await inviteAndAccept(owner, org.id, 'coach2@example.com', 'coach', mailer)
    const referee = await inviteAndAccept(owner, org.id, 'ref2@example.com', 'referee', mailer)

    for (const actor of [coach, referee]) {
      const res = await candidates(actor, game.id)
      expect(res.status, actor.email).toBe(403)
    }
  })
})

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and newlines, CRLF and a BOM', () => {
    const table = parseCsv('﻿a,b\r\n"x,1","line\nbreak"\r\nplain,"say ""hi"""\r\n')
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([
      ['x,1', 'line\nbreak'],
      ['plain', 'say "hi"'],
    ])
  })

  it('ignores blank lines and a trailing newline', () => {
    const table = parseCsv('name\nAda\n\nBen\n')
    expect(table.rows).toEqual([['Ada'], ['Ben']])
  })

  it('round-trips through toCsv', () => {
    const csv = toCsv(['name', 'note'], [['Ada, A', 'said "hi"'], ['Ben', null]])
    const table = parseCsv(csv)
    expect(table.rows).toEqual([
      ['Ada, A', 'said "hi"'],
      ['Ben', ''],
    ])
  })
})

describe('roster CSV validation', () => {
  it('accepts a clean file and normalises header aliases', () => {
    const result = parseRosterCsv(
      'Full Name,Email Address,Jersey Number,Role\nAda Okonkwo,ada@example.com,7,player\nBen Alvarez,ben@example.com,9,coach',
    )
    expect(result.errors).toEqual([])
    expect(result.columns).toEqual(['name', 'email', 'jersey', 'role'])
    expect(result.rows[0]).toMatchObject({ name: 'Ada Okonkwo', jersey: '7', role: 'player' })
    expect(result.rows[1]!.role).toBe('coach')
  })

  it('reports every problem rather than stopping at the first', () => {
    const result = parseRosterCsv(
      [
        'name,email,role,jersey,dob',
        ',nope,player,7,2013-01-01', // missing name, bad email
        'Ada,ada@example.com,goalie,7,2013-01-01', // bad role, duplicate jersey
        'Ada,other@example.com,player,8,13-01-01', // duplicate name, bad date
      ].join('\n'),
    )

    const columns = result.errors.map((error) => `${error.line}:${error.column}`)
    expect(columns).toContain('1:name')
    expect(columns).toContain('1:email')
    expect(columns).toContain('2:role')
    expect(columns).toContain('2:jersey')
    expect(columns).toContain('3:name')
    expect(columns).toContain('3:dob')
    // All four rows are still returned, so the preview can show them alongside errors.
    expect(result.rows).toHaveLength(3)
  })

  it('requires a name column and says so once', () => {
    const result = parseRosterCsv('email,role\nada@example.com,player')
    expect(result.errors).toEqual([
      { line: 0, column: 'name', message: 'A "name" column is required.' },
    ])
    expect(result.rows).toEqual([])
  })

  it('defaults a blank role to player and keeps blanks null', () => {
    const result = parseRosterCsv('name,email,role,jersey\nAda,,,')
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({ role: 'player', email: null, jersey: null })
  })

  it('reports a header-only file', () => {
    const result = parseRosterCsv('name,email')
    expect(result.errors.map((error) => error.message)).toContain('The file has a header but no rows.')
  })
})

describe('roster import endpoint', () => {
  const importCsv = (actor: TestUser, teamId: string, csv: string, commit = false) =>
    call<{ orgId: string; teamId: string }>(
      importRoster,
      `/api/orgs/${org.id}/teams/${teamId}/import`,
      { token: actor.token, params: { orgId: org.id, teamId }, body: { csv, commit } },
    )

  const CLEAN = 'name,email,role,jersey\nAda Okonkwo,ada@example.com,player,7\nBen Alvarez,ben@example.com,coach,'

  it('previews without writing anything', async () => {
    const res = await importCsv(owner, teamIds[0]!, CLEAN)
    expect(res.status).toBe(200)
    expect(res.body.committed).toBe(false)
    expect(res.body.summary).toMatchObject({ rows: 2, created: 2, added: 0, updated: 0 })
    expect(res.body.plan.map((entry: { action: string }) => entry.action)).toEqual([
      'create_person_and_add',
      'create_person_and_add',
    ])
    // Nothing at all was written.
    expect(await prisma.person.count()).toBe(0)
    expect(await prisma.teamMembership.count()).toBe(0)
  })

  it('commits in one go and records the import in the audit trail', async () => {
    const res = await importCsv(owner, teamIds[0]!, CLEAN, true)
    expect(res.status).toBe(200)
    expect(res.body.committed).toBe(true)
    expect(res.body.summary).toMatchObject({ peopleCreated: 2, membershipsCreated: 2 })

    const members = await prisma.teamMembership.findMany({
      where: { teamId: teamIds[0], deletedAt: null },
      include: { person: true },
    })
    expect(members.map((member) => member.person.name).sort()).toEqual([
      'Ada Okonkwo',
      'Ben Alvarez',
    ])
    expect(members.find((member) => member.person.name === 'Ben Alvarez')!.role).toBe('coach')

    const summary = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'roster.imported', entityId: teamIds[0] },
    })
    expect((summary.meta as Record<string, unknown>).peopleCreated).toBe(2)
    // Every row gets its own event too, not just the summary.
    expect(
      await prisma.auditEvent.count({ where: { action: 'membership.created' } }),
    ).toBe(2)
  })

  it('refuses to commit an invalid file and writes nothing', async () => {
    const res = await importCsv(
      owner,
      teamIds[0]!,
      'name,email\nAda,not-an-email\n,also@example.com',
      true,
    )
    expect(res.status).toBe(422)
    expect(res.body.committed).toBe(false)
    expect(res.body.errors.length).toBeGreaterThan(0)
    expect(await prisma.person.count()).toBe(0)
  })

  it('matches an existing person by email rather than creating a second one', async () => {
    await importCsv(owner, teamIds[0]!, CLEAN, true)

    // Same person, different spelling of the name, same email — and a new team.
    const res = await importCsv(
      owner,
      teamIds[1]!,
      'name,email,role,jersey\nAda O.,ada@example.com,player,11',
      true,
    )
    expect(res.status).toBe(200)
    expect(res.body.summary).toMatchObject({ peopleCreated: 0, membershipsCreated: 1 })
    expect(await prisma.person.count({ where: { deletedAt: null } })).toBe(2)
  })

  it('updates rather than duplicates a member already on the team', async () => {
    await importCsv(owner, teamIds[0]!, CLEAN, true)
    const res = await importCsv(
      owner,
      teamIds[0]!,
      'name,email,role,jersey\nAda Okonkwo,ada@example.com,manager,7',
      true,
    )
    expect(res.status).toBe(200)
    expect(res.body.summary).toMatchObject({ membershipsCreated: 0, membershipsUpdated: 1 })

    const memberships = await prisma.teamMembership.findMany({
      where: { teamId: teamIds[0], deletedAt: null, person: { email: 'ada@example.com' } },
    })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.role).toBe('manager')
  })

  it('rejects a jersey already worn by someone else on that team', async () => {
    await importCsv(owner, teamIds[0]!, CLEAN, true)
    const res = await importCsv(
      owner,
      teamIds[0]!,
      'name,email,role,jersey\nCara Diaz,cara@example.com,player,7',
      true,
    )
    expect(res.status).toBe(422)
    expect(res.body.errors.map((error: { message: string }) => error.message).join(' ')).toMatch(
      /Jersey 7 is already taken/,
    )
  })

  it('lets a coach import for their own team and nobody else’s', async () => {
    const coach = await inviteAndAccept(owner, org.id, 'coach3@example.com', 'coach', mailer)
    const person = await createPerson(owner, org.id, 'Coach Three', { userId: coach.id })
    await prisma.teamMembership.create({
      data: { teamId: teamIds[0]!, personId: person.id, role: 'coach' },
    })

    const own = await importCsv(coach, teamIds[0]!, CLEAN, true)
    expect(own.status).toBe(200)

    const other = await importCsv(coach, teamIds[1]!, CLEAN, true)
    expect(other.status).toBe(403)
    expect(
      await prisma.teamMembership.count({ where: { teamId: teamIds[1], deletedAt: null } }),
    ).toBe(0)
  })

  it('refuses a viewer outright', async () => {
    const viewer = await inviteAndAccept(owner, org.id, 'viewer2@example.com', 'viewer', mailer)
    const res = await importCsv(viewer, teamIds[0]!, CLEAN, true)
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// The shared read layer and the grid
// ---------------------------------------------------------------------------

describe('schedule read layer', () => {
  it('serves live rows to a draft reader and nothing to everyone else', async () => {
    await gen(owner, { commit: true, config: { seed: 12, roundRobinTimes: 1 } })

    const draft = await readSchedule({ orgId: org.id, seasonId: season.id, canReadDrafts: true })
    expect(draft.source).toBe('live')
    expect(draft.rows.length).toBe(6)

    const publicRead = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: false,
    })
    expect(publicRead.source).toBe('none')
    expect(publicRead.rows).toEqual([])
  })

  it('serves the frozen snapshot once published, even after the draft moves on', async () => {
    await gen(owner, { commit: true, config: { seed: 13, roundRobinTimes: 1 } })
    const versions = await call<{ orgId: string; seasonId: string }>(
      listVersions,
      `/api/orgs/${org.id}/seasons/${season.id}/versions`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id } },
    )
    const versionId = versions.body.versions[0]!.id
    await call<{ orgId: string; seasonId: string; versionId: string }>(
      publish,
      `/api/orgs/${org.id}/seasons/${season.id}/versions/${versionId}/publish`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id, versionId }, body: {} },
    )

    const before = await readSchedule({ orgId: org.id, seasonId: season.id, canReadDrafts: false })
    expect(before.source).toBe('published')
    expect(before.rows).toHaveLength(6)

    // Move a game on the live draft. The published read must not notice.
    const game = (await games())[0]!
    await patch(owner, game.id, { startTime: '2026-05-16T15:00:00.000Z' })

    const after = await readSchedule({ orgId: org.id, seasonId: season.id, canReadDrafts: false })
    expect(after.rows).toHaveLength(6)
    expect(after.rows.map((row) => row.startTime.toISOString()).sort()).toEqual(
      before.rows.map((row) => row.startTime.toISOString()).sort(),
    )
  })

  it('filters by team, division, venue and referee', async () => {
    await gen(owner, { commit: true, config: { seed: 14, roundRobinTimes: 1 } })

    const byTeam = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: true,
      filter: { teamId: teamIds[0] },
    })
    expect(byTeam.rows.length).toBeGreaterThan(0)
    expect(byTeam.totalBeforeFilter).toBe(6)
    for (const row of byTeam.rows) {
      expect([row.homeTeamId, row.awayTeamId]).toContain(teamIds[0])
    }

    const byVenue = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: true,
      filter: { venueId },
    })
    expect(byVenue.rows).toHaveLength(6)

    const elsewhere = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: true,
      filter: { venueId: 'no-such-venue' },
    })
    expect(elsewhere.rows).toEqual([])

    const byReferee = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: true,
      filter: { refereeId: 'nobody' },
    })
    expect(byReferee.rows).toEqual([])
  })

  it('groups by the venue’s local date, not the UTC date', () => {
    const row = (startTime: string, timezone: string): ScheduleRow => ({
      id: startTime,
      seasonId: 's',
      divisionId: 'd',
      divisionName: 'U12',
      homeTeamId: 'a',
      homeTeamName: 'A',
      awayTeamId: 'b',
      awayTeamName: 'B',
      fieldId: 'f',
      fieldName: 'Field 1',
      venueId: 'v',
      venueName: 'Park',
      timezone,
      startTime: new Date(startTime),
      durationMinutes: 60,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      roundNumber: 1,
      notes: null,
      officials: [],
    })

    // 8pm Pacific on Saturday the 16th is already 03:00 UTC on Sunday the 17th.
    const grouped = groupByLocalDate([
      row('2026-05-17T03:00:00.000Z', 'America/Los_Angeles'),
      row('2026-05-16T16:00:00.000Z', 'America/Los_Angeles'),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.date).toBe('2026-05-16')
  })
})

describe('division standings', () => {
  type StandingRow = {
    teamId: string
    played: number
    won: number
    drawn: number
    lost: number
    goalsFor: number
    goalsAgainst: number
    goalDifference: number
    points: number
  }

  const standings = (actor: TestUser) =>
    call<{ orgId: string; seasonId: string }>(
      getStandings,
      `/api/orgs/${org.id}/seasons/${season.id}/standings`,
      { token: actor.token, params: { orgId: org.id, seasonId: season.id } },
    )

  it('counts a played game with a final score and ignores everything else', async () => {
    await gen(owner, { commit: true, config: { seed: 20, roundRobinTimes: 1 } })
    const [decided] = await games()
    await patch(owner, decided!.id, { status: 'played', homeScore: 2, awayScore: 0 })

    const res = await standings(owner)
    expect(res.status).toBe(200)
    const rows = res.body.divisions[0].standings as StandingRow[]

    const home = rows.find((r) => r.teamId === decided!.homeTeamId)!
    const away = rows.find((r) => r.teamId === decided!.awayTeamId)!
    expect(home).toMatchObject({ played: 1, won: 1, drawn: 0, lost: 0, points: 3, goalDifference: 2 })
    expect(away).toMatchObject({ played: 1, won: 0, drawn: 0, lost: 1, points: 0, goalDifference: -2 })

    // Every other team's games are still scheduled, not played — 0 across the board.
    for (const row of rows) {
      if (row.teamId === decided!.homeTeamId || row.teamId === decided!.awayTeamId) continue
      expect(row.played).toBe(0)
    }
  })

  it('serves live standings to a draft reader and nothing to everyone else until published', async () => {
    await gen(owner, { commit: true, config: { seed: 21, roundRobinTimes: 1 } })
    const [drawn] = await games()
    await patch(owner, drawn!.id, { status: 'played', homeScore: 1, awayScore: 1 })

    // Owner holds schedule:read (the draft-visible tier) and sees it immediately.
    const ownerRows = (await standings(owner)).body.divisions[0].standings as StandingRow[]
    expect(ownerRows.find((r) => r.teamId === drawn!.homeTeamId)!.played).toBe(1)

    // Viewer does not, and nothing has been published — sees an untouched table.
    const viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)
    const viewerRowsBefore = (await standings(viewer)).body.divisions[0].standings as StandingRow[]
    expect(viewerRowsBefore.every((r) => r.played === 0)).toBe(true)

    // A fresh save, taken *after* the score was recorded — the version `gen`'s commit
    // made is a snapshot from before that, and publishing it would not carry the
    // score, exactly like the "frozen snapshot" behaviour tested elsewhere.
    const saved = await call<{ orgId: string; seasonId: string }>(
      saveVersion,
      `/api/orgs/${org.id}/seasons/${season.id}/versions`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id }, body: {} },
    )
    const versionId = saved.body.version.id as string
    await call<{ orgId: string; seasonId: string; versionId: string }>(
      publish,
      `/api/orgs/${org.id}/seasons/${season.id}/versions/${versionId}/publish`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id, versionId }, body: {} },
    )

    // Same viewer, now off the published snapshot, sees the result.
    const viewerRowsAfter = (await standings(viewer)).body.divisions[0].standings as StandingRow[]
    const viewerRow = viewerRowsAfter.find((r) => r.teamId === drawn!.homeTeamId)!
    expect(viewerRow).toMatchObject({ played: 1, drawn: 1, points: 1 })
  })

  it('refuses a season that does not belong to the caller’s org', async () => {
    const otherOwner = await signUp('otherowner@example.com')
    const otherOrg = await createOrganization(otherOwner)

    const res = await call<{ orgId: string; seasonId: string }>(
      getStandings,
      `/api/orgs/${otherOrg.id}/seasons/${season.id}/standings`,
      { token: otherOwner.token, params: { orgId: otherOrg.id, seasonId: season.id } },
    )
    expect(res.status).toBe(404)
  })
})

describe('the drag-and-drop grid', () => {
  it('puts each game in the cell for its own field and local time', async () => {
    await gen(owner, { commit: true, config: { seed: 15, roundRobinTimes: 1 } })
    const schedule = await readSchedule({
      orgId: org.id,
      seasonId: season.id,
      canReadDrafts: true,
    })
    const fields = await prisma.field.findMany({
      where: { deletedAt: null },
      include: { venue: true, timeSlots: { where: { deletedAt: null } } },
    })

    const grid = buildScheduleGrid({
      rows: schedule.rows,
      fields: fields.map((field) => ({
        id: field.id,
        name: field.name,
        venueId: field.venueId,
        venueName: field.venue.name,
        timezone: field.venue.timezone,
        timeSlots: field.timeSlots,
      })),
    })

    expect(grid.columns).toHaveLength(2)
    expect(grid.days.length).toBeGreaterThan(0)

    // Every game appears exactly once across the whole grid, in a cell whose declared
    // instant equals the game's own start time.
    const placed = new Map<string, string>()
    for (const day of grid.days) {
      for (const timeRow of day.rows) {
        for (const cell of timeRow.cells) {
          for (const game of cell.games) {
            expect(placed.has(game.id)).toBe(false)
            placed.set(game.id, `${cell.fieldId}|${cell.startTime}`)
          }
        }
      }
    }
    for (const row of schedule.rows) {
      expect(placed.get(row.id)).toBe(`${row.fieldId}|${row.startTime.toISOString()}`)
    }
  })

  it('offers free slots as drop targets and lists unplaced games separately', async () => {
    await gen(owner, { commit: true, config: { seed: 16, roundRobinTimes: 1 } })
    const game = (await games())[0]!
    await prisma.game.update({ where: { id: game.id }, data: { fieldId: null } })

    const schedule = await readSchedule({ orgId: org.id, seasonId: season.id, canReadDrafts: true })
    const fields = await prisma.field.findMany({
      where: { deletedAt: null },
      include: { venue: true, timeSlots: { where: { deletedAt: null } } },
    })
    const grid = buildScheduleGrid({
      rows: schedule.rows,
      fields: fields.map((field) => ({
        id: field.id,
        name: field.name,
        venueId: field.venueId,
        venueName: field.venue.name,
        timezone: field.venue.timezone,
        timeSlots: field.timeSlots,
      })),
    })

    expect(grid.unplaced.map((entry) => entry.id)).toEqual([game.id])

    // The 08:00–18:00 Saturday window yields more targets than there are games,
    // otherwise there would be nowhere legal to drag anything.
    const cells = grid.days.flatMap((day) => day.rows.flatMap((timeRow) => timeRow.cells))
    const empty = cells.filter((cell) => cell.games.length === 0)
    expect(empty.length).toBeGreaterThan(0)
  })
})
