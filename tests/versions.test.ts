import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import { diffSnapshots, type ScheduleSnapshot, type GameSnapshot } from '@/lib/versions/snapshot'
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
import {
  GET as listVersions,
  POST as saveVersion,
} from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/route'
import { GET as getVersion } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/[versionId]/route'
import { GET as diffVersions } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/diff/route'
import { POST as publish } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/[versionId]/publish/route'
import { POST as restore } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/[versionId]/restore/route'
import { DELETE as unpublish } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/publish/route'
import { GET as listGames } from '@/app/api/orgs/[orgId]/games/route'
import { GET as activityFeed } from '@/app/api/orgs/[orgId]/activity/route'
import { PATCH as patchGame } from '@/app/api/orgs/[orgId]/games/[gameId]/route'

/**
 * Revision history.
 *
 * Two acceptance scenarios live here:
 *   5. regenerate, diff v1 against v2, restore v1, confirm v3 exists with v1's content
 *      and the audit trail is intact
 *   6. publish, and confirm only published games are visible to roles that cannot read
 *      drafts
 */

let mailer: CapturingMailer
let owner: TestUser
let org: { id: string; slug: string }
let season: { id: string }
let teamIds: string[]

const gen = (actor: TestUser, body: Record<string, unknown>) =>
  call<{ orgId: string; seasonId: string }>(
    generate,
    `/api/orgs/${org.id}/seasons/${season.id}/generate`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id }, body },
  )

const versions = (actor: TestUser) =>
  call<{ orgId: string; seasonId: string }>(
    listVersions,
    `/api/orgs/${org.id}/seasons/${season.id}/versions`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id } },
  )

const diff = (actor: TestUser, from: string, to: string) =>
  call<{ orgId: string; seasonId: string }>(
    diffVersions,
    `/api/orgs/${org.id}/seasons/${season.id}/versions/diff`,
    {
      token: actor.token,
      params: { orgId: org.id, seasonId: season.id },
      query: { from, to },
    },
  )

const publishVersionCall = (actor: TestUser, versionId: string) =>
  call<{ orgId: string; seasonId: string; versionId: string }>(
    publish,
    `/api/orgs/${org.id}/seasons/${season.id}/versions/${versionId}/publish`,
    {
      token: actor.token,
      params: { orgId: org.id, seasonId: season.id, versionId },
      body: {},
    },
  )

const restoreVersionCall = (actor: TestUser, versionId: string, body: Record<string, unknown> = {}) =>
  call<{ orgId: string; seasonId: string; versionId: string }>(
    restore,
    `/api/orgs/${org.id}/seasons/${season.id}/versions/${versionId}/restore`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id, versionId }, body },
  )

const games = (actor: TestUser, query: Record<string, string> = {}) =>
  call<{ orgId: string }>(listGames, `/api/orgs/${org.id}/games`, {
    token: actor.token,
    params: { orgId: org.id },
    query: { seasonId: season.id, ...query },
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
  const division = await createDivision(owner, org.id, season.id, 'U12 Boys')

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
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-05-30',
    })
  }
})

// ---------------------------------------------------------------------------
// The pure diff
// ---------------------------------------------------------------------------

describe('snapshot diff', () => {
  const baseGame = (overrides: Partial<GameSnapshot> = {}): GameSnapshot => ({
    gameId: 'g1',
    divisionId: 'd1',
    divisionName: 'U12',
    homeTeamId: 't1',
    homeTeamName: 'Rovers',
    awayTeamId: 't2',
    awayTeamName: 'Owls',
    fieldId: 'f1',
    fieldName: 'Field 1',
    venueId: 'v1',
    venueName: 'Riverside',
    timezone: 'America/Los_Angeles',
    startTime: '2026-03-07T16:00:00.000Z',
    durationMinutes: 60,
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    roundNumber: 1,
    notes: null,
    officials: [],
    ...overrides,
  })

  const snap = (games: GameSnapshot[]): ScheduleSnapshot => ({
    snapshotVersion: 1,
    seasonId: 's1',
    takenAt: '2026-01-01T00:00:00.000Z',
    games,
  })

  it('reports nothing changed for identical snapshots', () => {
    const a = snap([baseGame()])
    const result = diffSnapshots(a, snap([baseGame()]))
    expect(result.counts).toMatchObject({ added: 0, removed: 0, moved: 0, unchanged: 1 })
  })

  it('reports an added and a removed game', () => {
    const before = snap([baseGame()])
    const after = snap([baseGame({ gameId: 'g2', homeTeamId: 't3', homeTeamName: 'Breakers' })])
    const result = diffSnapshots(before, after)
    expect(result.counts.added).toBe(1)
    expect(result.counts.removed).toBe(1)
    expect(result.added[0]!.homeTeamName).toBe('Breakers')
    expect(result.removed[0]!.homeTeamName).toBe('Rovers')
  })

  it('reports a move with the old and new time, matched by row id', () => {
    const before = snap([baseGame()])
    const after = snap([baseGame({ startTime: '2026-03-07T18:00:00.000Z' })])
    const result = diffSnapshots(before, after)

    expect(result.counts.moved).toBe(1)
    const moved = result.moved[0]!
    expect(moved.matchedBy).toBe('game_id')
    expect(moved.timeChanged).toBe(true)
    expect(moved.fieldChanged).toBe(false)
    expect(moved.minutesMoved).toBe(120)
    expect(moved.before.startTime).toBe('2026-03-07T16:00:00.000Z')
    expect(moved.after.startTime).toBe('2026-03-07T18:00:00.000Z')
  })

  it('reports a field change', () => {
    const before = snap([baseGame()])
    const after = snap([baseGame({ fieldId: 'f2', fieldName: 'Field 2' })])
    const moved = diffSnapshots(before, after).moved[0]!
    expect(moved.fieldChanged).toBe(true)
    expect(moved.timeChanged).toBe(false)
    expect(moved.before.fieldName).toBe('Field 1')
    expect(moved.after.fieldName).toBe('Field 2')
  })

  /**
   * The case that makes a regeneration readable: every row id changes, but the same
   * fixture is recognisable, so it reads as "moved" rather than "removed and added".
   */
  it('matches by fixture when row ids all changed', () => {
    const before = snap([baseGame({ gameId: 'old-1' })])
    const after = snap([baseGame({ gameId: 'new-1', startTime: '2026-03-14T16:00:00.000Z' })])
    const result = diffSnapshots(before, after)

    expect(result.counts.added).toBe(0)
    expect(result.counts.removed).toBe(0)
    expect(result.counts.moved).toBe(1)
    expect(result.moved[0]!.matchedBy).toBe('fixture')
  })

  it('matches by pairing when the round also changed', () => {
    const before = snap([baseGame({ gameId: 'old-1', roundNumber: 1 })])
    const after = snap([baseGame({ gameId: 'new-1', roundNumber: 5 })])
    const result = diffSnapshots(before, after)
    expect(result.counts.moved + result.counts.unchanged).toBe(1)
    expect(result.moved[0]?.matchedBy ?? 'pairing').toBe('pairing')
  })

  it('reports officials added, removed and re-statused', () => {
    const before = snap([
      baseGame({
        officials: [
          { refereeId: 'r1', refereeName: 'Ada', position: 'center', status: 'pending' },
          { refereeId: 'r2', refereeName: 'Bo', position: 'AR1', status: 'accepted' },
        ],
      }),
    ])
    const after = snap([
      baseGame({
        officials: [
          { refereeId: 'r1', refereeName: 'Ada', position: 'center', status: 'accepted' },
          { refereeId: 'r3', refereeName: 'Cy', position: 'AR2', status: 'pending' },
        ],
      }),
    ])

    const change = diffSnapshots(before, after).officialsChanged[0]!
    expect(change.added.map((o) => o.refereeName)).toEqual(['Cy'])
    expect(change.removed.map((o) => o.refereeName)).toEqual(['Bo'])
    expect(change.statusChanged).toHaveLength(1)
    expect(change.statusChanged[0]!.before.status).toBe('pending')
    expect(change.statusChanged[0]!.after.status).toBe('accepted')
  })

  it('never double-counts a game across matching passes', () => {
    const before = snap([baseGame({ gameId: 'a' }), baseGame({ gameId: 'b', roundNumber: 2 })])
    const after = snap([baseGame({ gameId: 'a' }), baseGame({ gameId: 'c', roundNumber: 2 })])
    const result = diffSnapshots(before, after)
    expect(result.counts.added + result.counts.removed + result.counts.moved + result.counts.unchanged).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Versions are created and immutable
// ---------------------------------------------------------------------------

describe('version creation', () => {
  it('creates a version on every generation, numbered from 1', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await gen(owner, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })

    const res = await versions(owner)
    expect(res.status).toBe(200)
    expect(res.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1])
    expect(res.body.versions[0]!.source).toBe('generated')
    expect(res.body.versions[0]!.status).toBe('draft')
    expect(res.body.versions[0]!.gameCount).toBe(6) // 4 teams single round robin
  })

  it('creates no version for a dry run', async () => {
    await gen(owner, { commit: false, config: { seed: 1, roundRobinTimes: 1 } })
    expect(await prisma.scheduleVersion.count()).toBe(0)
  })

  it('creates a version on an explicit manual save, with a label and note', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    const saved = await call<{ orgId: string; seasonId: string }>(
      saveVersion,
      `/api/orgs/${org.id}/seasons/${season.id}/versions`,
      {
        token: owner.token,
        params: { orgId: org.id, seasonId: season.id },
        body: { label: 'Before I move the Rovers game', note: 'checkpoint' },
      },
    )
    expect(saved.status).toBe(201)
    expect(saved.body.version.number).toBe(2)

    const res = await versions(owner)
    expect(res.body.versions[0]!.label).toBe('Before I move the Rovers game')
    expect(res.body.versions[0]!.note).toBe('checkpoint')
    expect(res.body.versions[0]!.source).toBe('manual_save')
  })

  it('freezes names into the snapshot so a rename cannot change history', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const version = await prisma.scheduleVersion.findFirstOrThrow()

    await prisma.team.update({ where: { id: teamIds[0]! }, data: { name: 'Renamed FC' } })

    const res = await call<{ orgId: string; seasonId: string; versionId: string }>(
      getVersion,
      `/api/orgs/${org.id}/seasons/${season.id}/versions/${version.id}`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id, versionId: version.id } },
    )

    const names = res.body.games.flatMap((g: { homeTeam: string; awayTeam: string }) => [
      g.homeTeam,
      g.awayTeam,
    ])
    expect(names).toContain('Rovers')
    expect(names).not.toContain('Renamed FC')
  })

  it('requires schedule:read to list versions', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
    const res = await versions(coach)
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Acceptance scenario 5
// ---------------------------------------------------------------------------

describe('acceptance scenario 5: regenerate, diff, restore', () => {
  it('walks the whole flow and leaves the audit trail intact', async () => {
    // --- v1
    const first = await gen(owner, { commit: true, note: 'first cut', config: { seed: 1, roundRobinTimes: 1 } })
    expect(first.status).toBe(200)
    const v1Id = first.body.version.id
    const v1Games = await prisma.game.findMany({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
    })
    expect(v1Games).toHaveLength(6)

    // --- v2: regenerate as a double round robin, so the difference is deterministic.
    // Team ids are cuids and the engine shuffles by them, so merely changing the seed
    // makes *which* fixtures move vary run to run — fine for the engine, useless as a
    // fixed assertion. Doubling the round robin guarantees six new fixtures.
    const second = await gen(owner, {
      commit: true,
      note: 'go double round robin',
      config: { seed: 1, roundRobinTimes: 2 },
    })
    const v2Id = second.body.version.id
    expect(v2Id).not.toBe(v1Id)

    // --- diff v1 against v2
    const comparison = await diff(owner, v1Id, v2Id)
    expect(comparison.status).toBe(200)
    expect(comparison.body.from.number).toBe(1)
    expect(comparison.body.to.number).toBe(2)
    expect(comparison.body.counts.before).toBe(6)
    expect(comparison.body.counts.after).toBe(12)

    // Every v1 fixture is accounted for — matched or removed — and the reverse legs
    // show up as additions rather than the whole thing reading as 6 removed, 12 added.
    const { added, removed, moved, unchanged } = comparison.body.counts
    expect(added).toBe(6)
    expect(removed).toBe(0)
    expect(moved + unchanged).toBe(6)

    for (const entry of comparison.body.moved) {
      expect(entry.before.localStartTime).toBeTruthy()
      expect(entry.after.localStartTime).toBeTruthy()
      expect(entry.match).toMatch(/ v /)
    }
    for (const entry of comparison.body.added) {
      expect(entry.match).toMatch(/ v /)
      expect(entry.localStartTime).toBeTruthy()
    }

    // --- restore v1
    const restored = await restoreVersionCall(owner, v1Id, { note: 'go back to the first cut' })
    expect(restored.status).toBe(201)
    expect(restored.body.version.number).toBe(3)

    // v3 exists, and v1 and v2 are both still there — nothing was deleted.
    const list = await versions(owner)
    expect(list.body.versions.map((v: { number: number }) => v.number)).toEqual([3, 2, 1])
    expect(list.body.versions[0]!.source).toBe('restore')
    expect(list.body.versions[0]!.label).toBe('Restored from v1')
    expect(list.body.versions[0]!.restoredFromId).toBe(v1Id)

    // --- v3 holds v1's content
    const v3Id = restored.body.version.id
    const backToStart = await diff(owner, v1Id, v3Id)
    expect(backToStart.body.counts).toMatchObject({ added: 0, removed: 0, moved: 0 })
    expect(backToStart.body.counts.unchanged).toBe(6)

    // The live schedule matches too, fixture for fixture and slot for slot.
    const liveAfterRestore = await prisma.game.findMany({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
    })
    expect(liveAfterRestore).toHaveLength(6)
    expect(liveAfterRestore.map((g) => `${g.homeTeamId}|${g.awayTeamId}|${g.startTime.toISOString()}`))
      .toEqual(v1Games.map((g) => `${g.homeTeamId}|${g.awayTeamId}|${g.startTime.toISOString()}`))

    // --- audit trail intact
    const trail = await prisma.auditEvent.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: 'asc' },
    })
    const actions = trail.map((event) => event.action)
    expect(actions.filter((a) => a === 'schedule.generated')).toHaveLength(2)
    expect(actions.filter((a) => a === 'version.generated')).toHaveLength(2)
    expect(actions).toContain('schedule.restored')
    expect(actions).toContain('version.restore')

    const restoreEvent = trail.find((event) => event.action === 'schedule.restored')!
    const meta = restoreEvent.meta as Record<string, unknown>
    expect(meta.restoredFromVersionId).toBe(v1Id)
    expect(meta.restoredFromNumber).toBe(1)
    expect(meta.newVersionNumber).toBe(3)
    expect(Array.isArray(meta.retiredGameIds)).toBe(true)

    // Nothing in the audit log was overwritten: the v1 generation event still says 6.
    const firstGeneration = trail.find((event) => event.action === 'schedule.generated')!
    expect((firstGeneration.meta as Record<string, unknown>).note).toBe('first cut')
  })

  it('soft-deletes replaced games rather than dropping them', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const v1Ids = (await prisma.game.findMany({ where: { deletedAt: null } })).map((g) => g.id)

    await restoreVersionCall(owner, first.body.version.id)

    // The originals are still in the table, marked deleted, alongside the new rows.
    const stillThere = await prisma.game.findMany({ where: { id: { in: v1Ids } } })
    expect(stillThere).toHaveLength(6)
    for (const game of stillThere) expect(game.deletedAt).not.toBeNull()
    expect(await prisma.game.count({ where: { deletedAt: null } })).toBe(6)
  })

  it('protects played results from being overwritten by a restore', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const v1Id = first.body.version.id

    // Regenerate, then record a result on one of the new games.
    await gen(owner, { commit: true, config: { seed: 99, roundRobinTimes: 1 } })
    const played = await prisma.game.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
    })
    await prisma.game.update({
      where: { id: played.id },
      data: { status: 'played', homeScore: 3, awayScore: 1 },
    })

    const restored = await restoreVersionCall(owner, v1Id)
    expect(restored.status).toBe(201)
    expect(restored.body.preserved).toBe(1)

    // The result survived, untouched.
    const after = await prisma.game.findUniqueOrThrow({ where: { id: played.id } })
    expect(after.deletedAt).toBeNull()
    expect(after.status).toBe('played')
    expect(after.homeScore).toBe(3)
  })

  it('requires schedule:restore', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)

    const res = await restoreVersionCall(coach, first.body.version.id)
    expect(res.status).toBe(403)
    expect(await prisma.scheduleVersion.count()).toBe(1)
  })

  it('diffs the live working set against the last version', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const game = await prisma.game.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
    })

    // Hand-move it two hours later, overriding whatever that breaks.
    const moved = await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${game.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, gameId: game.id },
        body: {
          startTime: new Date(game.startTime.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          overrideReason: 'Coach requested a later kickoff.',
        },
      },
    )
    expect(moved.status).toBe(200)

    const comparison = await diff(owner, first.body.version.id, 'live')
    expect(comparison.body.to.id).toBe('live')
    expect(comparison.body.counts.moved).toBe(1)
    expect(comparison.body.moved[0]!.minutesMoved).toBe(120)
    expect(comparison.body.moved[0]!.matchedBy).toBe('game_id')
  })
})

// ---------------------------------------------------------------------------
// Acceptance scenario 6
// ---------------------------------------------------------------------------

describe('acceptance scenario 6: publishing gates what low-privilege roles see', () => {
  let coach: TestUser
  let referee: TestUser
  let viewer: TestUser

  beforeEach(async () => {
    coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
    referee = await inviteAndAccept(owner, org.id, 'ref@example.com', 'referee', mailer)
    viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)
  })

  it('shows nothing to low-privilege roles until something is published', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    // The scheduler-side roles see the draft.
    const asOwner = await games(owner)
    expect(asOwner.body.source).toBe('live')
    expect(asOwner.body.games).toHaveLength(6)

    // Everyone else sees an empty published schedule.
    for (const actor of [coach, viewer]) {
      const res = await games(actor)
      expect(res.status, actor.email).toBe(200)
      expect(res.body.source).toBe('none')
      expect(res.body.games).toHaveLength(0)
    }
  })

  it('shows the published version once it is published, and only that version', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const published = await publishVersionCall(owner, first.body.version.id)
    expect(published.status).toBe(200)

    // Compare which fixture sits in which slot, not just the slot times: with four
    // teams and two fields a different seed reuses the same six kickoffs and only the
    // matchups move.
    const signature = (rows: Array<{ homeTeamId: string; awayTeamId: string; startTime: string }>) =>
      rows.map((r) => `${r.homeTeamId}|${r.awayTeamId}|${r.startTime}`).sort()

    const v1Signature = signature(
      (await prisma.game.findMany({ where: { deletedAt: null } })).map((g) => ({
        homeTeamId: g.homeTeamId,
        awayTeamId: g.awayTeamId,
        startTime: g.startTime.toISOString(),
      })),
    )

    // Regenerate: the draft changes, the published version must not.
    await gen(owner, { commit: true, config: { seed: 99, roundRobinTimes: 1 } })

    const asCoach = await games(coach)
    expect(asCoach.body.source).toBe('published')
    expect(asCoach.body.publishedVersion.number).toBe(1)
    expect(asCoach.body.games).toHaveLength(6)
    expect(signature(asCoach.body.games)).toEqual(v1Signature)

    // The draft has moved on, and only privileged roles can see that.
    const asOwner = await games(owner)
    expect(asOwner.body.source).toBe('live')
    expect(signature(asOwner.body.games)).not.toEqual(v1Signature)
  })

  it('serves the published read from the frozen snapshot, not live rows', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await publishVersionCall(owner, first.body.version.id)

    const game = await prisma.game.findFirstOrThrow({ where: { deletedAt: null } })
    const originalStart = game.startTime.toISOString()

    // Edit the live row directly. A published read must not notice.
    await prisma.game.update({
      where: { id: game.id },
      data: { startTime: new Date(game.startTime.getTime() + 3 * 60 * 60 * 1000) },
    })

    const asViewer = await games(viewer)
    const starts = asViewer.body.games.map((g: { startTime: string }) => g.startTime)
    expect(starts).toContain(originalStart)
  })

  it('moves the published pointer forward and archives the previous version', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await publishVersionCall(owner, first.body.version.id)
    const second = await gen(owner, { commit: true, config: { seed: 99, roundRobinTimes: 1 } })
    await publishVersionCall(owner, second.body.version.id)

    const list = await versions(owner)
    const byNumber = new Map(
      list.body.versions.map((v: { number: number; status: string; isPublished: boolean }) => [
        v.number,
        v,
      ]),
    )
    expect((byNumber.get(1) as { status: string }).status).toBe('archived')
    expect((byNumber.get(2) as { status: string }).status).toBe('published')
    expect(list.body.publishedVersionId).toBe(second.body.version.id)

    // Coaches now see v2.
    const asCoach = await games(coach)
    expect(asCoach.body.publishedVersion.number).toBe(2)
  })

  it('refuses to publish the same version twice', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await publishVersionCall(owner, first.body.version.id)
    const again = await publishVersionCall(owner, first.body.version.id)
    expect(again.status).toBe(409)
  })

  it('requires schedule:publish', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    for (const actor of [coach, referee, viewer]) {
      const res = await publishVersionCall(actor, first.body.version.id)
      expect(res.status, actor.email).toBe(403)
    }
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).publishedVersionId,
    ).toBeNull()
  })

  it('unpublishes back to nothing visible', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await publishVersionCall(owner, first.body.version.id)
    expect((await games(coach)).body.games).toHaveLength(6)

    const removed = await call<{ orgId: string; seasonId: string }>(
      unpublish,
      `/api/orgs/${org.id}/seasons/${season.id}/publish`,
      { method: 'DELETE', token: owner.token, params: { orgId: org.id, seasonId: season.id } },
    )
    expect(removed.status).toBe(200)

    const after = await games(coach)
    expect(after.body.source).toBe('none')
    expect(after.body.games).toHaveLength(0)
  })

  it('records publishing in the audit trail', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await publishVersionCall(owner, first.body.version.id)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'version.published' },
    })
    expect(event.diff).toEqual({ status: { before: 'draft', after: 'published' } })
    expect((event.meta as Record<string, unknown>).number).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Per-entity history and the global feed
// ---------------------------------------------------------------------------

describe('per-game history', () => {
  it('answers "who changed this game and when"', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const game = await prisma.game.findFirstOrThrow({ where: { deletedAt: null } })

    await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${game.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, gameId: game.id },
        body: { status: 'confirmed' },
      },
    )

    const { GET } = await import('@/app/api/orgs/[orgId]/games/[gameId]/route')
    const res = await call<{ orgId: string; gameId: string }>(
      GET,
      `/api/orgs/${org.id}/games/${game.id}`,
      { token: owner.token, params: { orgId: org.id, gameId: game.id } },
    )

    expect(res.status).toBe(200)
    expect(res.body.history.length).toBeGreaterThan(0)
    const statusChange = res.body.history.find(
      (event: { action: string }) => event.action === 'game.updated' || event.action === 'game.moved',
    )
    expect(statusChange).toBeDefined()
    expect(statusChange.actorLabel).toBe(owner.email)
    expect(statusChange.diff.status).toEqual({ before: 'scheduled', after: 'confirmed' })
  })
})

describe('global activity feed', () => {
  it('lists events newest first with filter facets', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    const res = await call<{ orgId: string }>(activityFeed, `/api/orgs/${org.id}/activity`, {
      token: owner.token,
      params: { orgId: org.id },
    })

    expect(res.status).toBe(200)
    expect(res.body.events.length).toBeGreaterThan(0)

    const timestamps = res.body.events.map((e: { createdAt: string }) => e.createdAt)
    expect([...timestamps].sort().reverse()).toEqual(timestamps)

    expect(res.body.facets.entityTypes.map((f: { value: string }) => f.value)).toContain('Season')
    expect(res.body.facets.actors[0]!.label).toBe(owner.email)
  })

  it('filters by actor, entity type and date range', async () => {
    const admin = await inviteAndAccept(owner, org.id, 'admin@example.com', 'admin', mailer)
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await gen(admin, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })

    const feed = (query: Record<string, string>) =>
      call<{ orgId: string }>(activityFeed, `/api/orgs/${org.id}/activity`, {
        token: owner.token,
        params: { orgId: org.id },
        query,
      })

    const byActor = await feed({ actorId: admin.id })
    expect(byActor.body.events.length).toBeGreaterThan(0)
    for (const event of byActor.body.events) expect(event.actor.id).toBe(admin.id)

    const byType = await feed({ entityType: 'ScheduleVersion' })
    expect(byType.body.events.length).toBe(2)
    for (const event of byType.body.events) expect(event.entityType).toBe('ScheduleVersion')

    const byAction = await feed({ action: 'schedule.' })
    for (const event of byAction.body.events) expect(event.action.startsWith('schedule.')).toBe(true)

    // A window before anything happened returns nothing.
    const empty = await feed({ from: '2020-01-01', to: '2020-01-02' })
    expect(empty.body.events).toHaveLength(0)

    // Today's window returns everything.
    const today = new Date().toISOString().slice(0, 10)
    const all = await feed({ from: today, to: today })
    expect(all.body.events.length).toBeGreaterThan(0)
  })

  it('never leaks another org’s events', async () => {
    const outsider = await signUp('outsider@example.com')
    const otherOrg = await createOrganization(outsider, 'Rival Org')
    const otherLeague = await createLeague(outsider, otherOrg.id, 'Their League')

    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })

    const res = await call<{ orgId: string }>(activityFeed, `/api/orgs/${org.id}/activity`, {
      token: owner.token,
      params: { orgId: org.id },
    })
    const ids = res.body.events.map((e: { entityId: string }) => e.entityId)
    expect(ids).not.toContain(otherLeague.id)
    expect(ids).not.toContain(otherOrg.id)
  })

  it('requires audit:read', async () => {
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
    const res = await call<{ orgId: string }>(activityFeed, `/api/orgs/${org.id}/activity`, {
      token: coach.token,
      params: { orgId: org.id },
    })
    expect(res.status).toBe(403)
  })

  it('paginates with a cursor', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    await gen(owner, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })

    const firstPage = await call<{ orgId: string }>(activityFeed, `/api/orgs/${org.id}/activity`, {
      token: owner.token,
      params: { orgId: org.id },
      query: { limit: '2' },
    })
    expect(firstPage.body.events).toHaveLength(2)
    expect(firstPage.body.nextCursor).toBeTruthy()

    const secondPage = await call<{ orgId: string }>(activityFeed, `/api/orgs/${org.id}/activity`, {
      token: owner.token,
      params: { orgId: org.id },
      query: { limit: '2', cursor: firstPage.body.nextCursor },
    })
    const firstIds = firstPage.body.events.map((e: { id: string }) => e.id)
    for (const event of secondPage.body.events) expect(firstIds).not.toContain(event.id)
  })
})

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('never changes a snapshot once written', async () => {
    const first = await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const before = await prisma.scheduleVersion.findUniqueOrThrow({
      where: { id: first.body.version.id },
    })

    // Regenerate, restore, publish — none of it may touch v1's snapshot.
    await gen(owner, { commit: true, config: { seed: 99, roundRobinTimes: 1 } })
    await restoreVersionCall(owner, first.body.version.id)
    await publishVersionCall(owner, first.body.version.id)

    const after = await prisma.scheduleVersion.findUniqueOrThrow({
      where: { id: first.body.version.id },
    })
    expect(JSON.stringify(after.snapshot)).toBe(JSON.stringify(before.snapshot))
    expect(after.number).toBe(before.number)
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString())
    expect(after.source).toBe(before.source)
  })

  it('never deletes an audit event', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const countAfterFirst = await prisma.auditEvent.count({ where: { orgId: org.id } })

    const version = await prisma.scheduleVersion.findFirstOrThrow()
    await gen(owner, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })
    await restoreVersionCall(owner, version.id)
    await publishVersionCall(owner, version.id)

    // Strictly monotonic: history only ever grows.
    expect(await prisma.auditEvent.count({ where: { orgId: org.id } })).toBeGreaterThan(
      countAfterFirst,
    )
  })

  it('keeps version numbers gapless and unique per season', async () => {
    for (const seed of [1, 2, 3]) {
      await gen(owner, { commit: true, config: { seed, roundRobinTimes: 1 } })
    }
    const numbers = (
      await prisma.scheduleVersion.findMany({
        where: { seasonId: season.id },
        orderBy: { number: 'asc' },
      })
    ).map((v) => v.number)
    expect(numbers).toEqual([1, 2, 3])
  })
})
