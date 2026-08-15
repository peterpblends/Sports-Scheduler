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
import { GET as listVersions } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/route'
import { POST as publish } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/[versionId]/publish/route'
import { GET as exportSeason } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/export/route'
import { GET as exportRoster } from '@/app/api/orgs/[orgId]/teams/[teamId]/export/route'
import { GET as listFeeds, POST as createFeedRoute } from '@/app/api/orgs/[orgId]/feeds/route'
import { DELETE as revokeFeed } from '@/app/api/orgs/[orgId]/feeds/[feedId]/route'
import { GET as feedIcs } from '@/app/api/feeds/[token]/route'
import {
  GET as getPrefs,
  PATCH as patchPrefs,
} from '@/app/api/orgs/[orgId]/notifications/route'
import { PATCH as patchGame } from '@/app/api/orgs/[orgId]/games/[gameId]/route'
import { POST as assignOfficial } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/route'
import { POST as importRoster } from '@/app/api/orgs/[orgId]/teams/[teamId]/import/route'
import { POST as addTeamMemberRoute } from '@/app/api/orgs/[orgId]/teams/[teamId]/members/route'

import { parseCsv } from '@/lib/csv'
import { buildIcal, escapeText, foldLine, icalInstant, scheduleToIcal } from '@/lib/export/ical'
import { scheduleToCsv, assignmentsToCsv } from '@/lib/export/csv'
import type { ScheduleRow } from '@/lib/schedule/read'

/**
 * Phase 6: getting the schedule out of the app.
 *
 * The distribution surfaces are where authorization is easiest to get wrong, because
 * each one is a new way to read the same data — an export that ignored the
 * published/draft split, or a calendar token that outlived its owner's membership,
 * would undo phase 4 quietly. Most of what is here tests exactly that.
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

async function publishCurrent(): Promise<number> {
  const versions = await call<{ orgId: string; seasonId: string }>(
    listVersions,
    `/api/orgs/${org.id}/seasons/${season.id}/versions`,
    { token: owner.token, params: { orgId: org.id, seasonId: season.id } },
  )
  const versionId = versions.body.versions[0]!.id
  const res = await call<{ orgId: string; seasonId: string; versionId: string }>(
    publish,
    `/api/orgs/${org.id}/seasons/${season.id}/versions/${versionId}/publish`,
    { token: owner.token, params: { orgId: org.id, seasonId: season.id, versionId }, body: {} },
  )
  if (res.status !== 200) throw new Error(`publish failed: ${JSON.stringify(res.body)}`)
  return versions.body.versions[0]!.number
}

const exportSeasonCsv = (actor: TestUser, query: Record<string, string> = {}) =>
  call<{ orgId: string; seasonId: string }>(
    exportSeason,
    `/api/orgs/${org.id}/seasons/${season.id}/export`,
    { token: actor.token, params: { orgId: org.id, seasonId: season.id }, query },
  )

const makeFeed = (actor: TestUser, body: Record<string, unknown>) =>
  call<{ orgId: string }>(createFeedRoute, `/api/orgs/${org.id}/feeds`, {
    token: actor.token,
    params: { orgId: org.id },
    body,
  })

async function fetchFeed(token: string): Promise<{ status: number; text: string }> {
  const res = await feedIcs(new Request(`http://test.local/api/feeds/${token}.ics`), {
    params: Promise.resolve({ token: `${token}.ics` }),
  })
  return { status: res.status, text: await res.text() }
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
  await prisma.season.update({ where: { id: season.id }, data: { status: 'active' } })

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
// iCalendar generation
// ---------------------------------------------------------------------------

describe('iCalendar generation', () => {
  const row = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
    id: 'g1',
    seasonId: 's1',
    divisionId: 'd1',
    divisionName: 'U12 Boys',
    homeTeamId: 't1',
    homeTeamName: 'Rovers',
    awayTeamId: 't2',
    awayTeamName: 'Owls',
    fieldId: 'f1',
    fieldName: 'Field 1',
    venueId: 'v1',
    venueName: 'Riverside Park',
    timezone: 'America/Los_Angeles',
    startTime: new Date('2026-05-16T16:00:00.000Z'),
    durationMinutes: 90,
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    roundNumber: 3,
    notes: null,
    officials: [],
    ...over,
  })

  it('stamps instants as UTC with no punctuation', () => {
    expect(icalInstant(new Date('2026-05-16T16:00:00.000Z'))).toBe('20260516T160000Z')
  })

  it('escapes backslashes before the sequences it introduces', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne')
  })

  it('folds long lines at 75 octets without splitting a character', () => {
    // Each emoji is four octets, so a naive character-count fold lands mid-sequence.
    const folded = foldLine(`SUMMARY:${'🏆'.repeat(40)}`)
    const lines = folded.split('\r\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    // Rejoining drops the fold and its leading space, giving back the original.
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'🏆'.repeat(40)}`)
  })

  it('emits a well-formed calendar with CRLF endings', () => {
    const ics = buildIcal({
      name: 'Test',
      stamp: new Date('2026-01-01T00:00:00.000Z'),
      events: [
        {
          uid: 'a@test',
          start: new Date('2026-05-16T16:00:00.000Z'),
          durationMinutes: 60,
          summary: 'Rovers v Owls',
        },
      ],
    })
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('DTSTART:20260516T160000Z')
    expect(ics).toContain('DTEND:20260516T170000Z')
    expect(ics).toContain('DTSTAMP:20260101T000000Z')
    // Every line ends CRLF, never a bare LF.
    expect(ics.split('\r\n').join('')).not.toContain('\n')
  })

  it('derives the UID from the game id so a reschedule replaces rather than duplicates', () => {
    const first = scheduleToIcal({ rows: [row()], name: 'T', domain: 'example.test' })
    const moved = scheduleToIcal({
      rows: [row({ startTime: new Date('2026-05-16T18:00:00.000Z') })],
      name: 'T',
      domain: 'example.test',
    })
    const uid = /UID:(.+)\r\n/.exec(first)![1]
    expect(uid).toBe('game-g1@example.test')
    expect(moved).toContain(`UID:${uid}`)
    expect(moved).toContain('DTSTART:20260516T180000Z')
  })

  it('marks a cancelled game CANCELLED rather than dropping it', () => {
    const ics = scheduleToIcal({
      rows: [row({ status: 'cancelled' })],
      name: 'T',
      domain: 'example.test',
    })
    expect(ics).toContain('STATUS:CANCELLED')
    expect(ics).toContain('UID:game-g1@example.test')

    const postponed = scheduleToIcal({
      rows: [row({ status: 'postponed' })],
      name: 'T',
      domain: 'example.test',
    })
    expect(postponed).toContain('STATUS:TENTATIVE')
  })

  it('puts the venue in LOCATION and the crew in DESCRIPTION', () => {
    const ics = scheduleToIcal({
      rows: [
        row({
          officials: [
            { id: 'o1', refereeId: 'r1', refereeName: 'Wei Chen', position: 'center', status: 'accepted' },
          ],
        }),
      ],
      name: 'T',
      domain: 'example.test',
    })
    expect(ics).toContain('LOCATION:Riverside Park — Field 1')
    expect(ics.replace(/\r\n /g, '')).toContain('Officials: Wei Chen')
  })
})

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('CSV export', () => {
  it('carries both the local reading and the UTC instant', async () => {
    await gen(owner, { commit: true, config: { seed: 1, roundRobinTimes: 1 } })
    const res = await exportSeasonCsv(owner)

    expect(res.status).toBe(200)
    expect(res.res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.res.headers.get('content-disposition')).toMatch(/attachment; filename=/)

    const table = parseCsv(res.text)
    expect(table.header).toContain('date')
    expect(table.header).toContain('time')
    expect(table.header).toContain('timezone')
    expect(table.header).toContain('start_utc')
    expect(table.rows).toHaveLength(6)

    const utc = table.header.indexOf('start_utc')
    const zone = table.header.indexOf('timezone')
    for (const cells of table.rows) {
      expect(cells[utc]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(cells[zone]).toBe('America/Los_Angeles')
    }
  })

  it('honours the published/draft split, so an export cannot leak a draft', async () => {
    await gen(owner, { commit: true, config: { seed: 2, roundRobinTimes: 1 } })
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)

    // Nothing published yet: a coach's export is empty even though the draft has games.
    const before = parseCsv((await exportSeasonCsv(coach)).text)
    expect(before.rows).toEqual([])

    await publishCurrent()
    const after = parseCsv((await exportSeasonCsv(coach)).text)
    expect(after.rows).toHaveLength(6)

    // Regenerate the draft. The coach's export must still show the published version.
    await gen(owner, { commit: true, config: { seed: 3, roundRobinTimes: 2 } })
    const later = parseCsv((await exportSeasonCsv(coach)).text)
    expect(later.rows).toHaveLength(6)

    const asOwner = parseCsv((await exportSeasonCsv(owner)).text)
    expect(asOwner.rows).toHaveLength(12)
  })

  it('keeps the officiating export away from roles without official:read', async () => {
    await gen(owner, { commit: true, config: { seed: 4, roundRobinTimes: 1 } })
    await publishCurrent()
    const coach = await inviteAndAccept(owner, org.id, 'coach2@example.com', 'coach', mailer)

    expect((await exportSeasonCsv(owner, { kind: 'assignments' })).status).toBe(200)
    expect((await exportSeasonCsv(coach, { kind: 'assignments' })).status).toBe(400)
  })

  it('applies the filters it is given', async () => {
    await gen(owner, { commit: true, config: { seed: 5, roundRobinTimes: 1 } })
    const all = parseCsv((await exportSeasonCsv(owner)).text)
    const one = parseCsv((await exportSeasonCsv(owner, { teamId: teamIds[0]! })).text)
    expect(one.rows.length).toBeGreaterThan(0)
    expect(one.rows.length).toBeLessThan(all.rows.length)
  })

  it('records an export in the audit trail', async () => {
    await gen(owner, { commit: true, config: { seed: 6, roundRobinTimes: 1 } })
    await exportSeasonCsv(owner)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'schedule.exported' },
      orderBy: { createdAt: 'desc' },
    })
    expect((event.meta as Record<string, unknown>).kind).toBe('schedule')
    expect((event.meta as Record<string, unknown>).source).toBe('live')
  })

  it('exports a roster in the columns the importer reads', async () => {
    const csv = 'name,email,role,jersey,dob\nAda Okonkwo,ada@example.com,player,7,2013-04-02'
    await call<{ orgId: string; teamId: string }>(
      importRoster,
      `/api/orgs/${org.id}/teams/${teamIds[0]}/import`,
      {
        token: owner.token,
        params: { orgId: org.id, teamId: teamIds[0]! },
        body: { csv, commit: true },
      },
    )

    const res = await call<{ orgId: string; teamId: string }>(
      exportRoster,
      `/api/orgs/${org.id}/teams/${teamIds[0]}/export`,
      { token: owner.token, params: { orgId: org.id, teamId: teamIds[0]! } },
    )
    expect(res.status).toBe(200)

    const table = parseCsv(res.text)
    expect(table.header).toEqual(['name', 'email', 'phone', 'role', 'jersey', 'dob', 'notes'])
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]![0]).toBe('Ada Okonkwo')
    expect(table.rows[0]![5]).toBe('2013-04-02')

    // Round trip: the export imports cleanly into another team.
    const round = await call<{ orgId: string; teamId: string }>(
      importRoster,
      `/api/orgs/${org.id}/teams/${teamIds[1]}/import`,
      {
        token: owner.token,
        params: { orgId: org.id, teamId: teamIds[1]! },
        body: { csv: res.text, commit: true },
      },
    )
    expect(round.status).toBe(200)
    expect(round.body.errors).toEqual([])
  })

  it('quotes a value containing a comma so the row still parses', () => {
    const rows: ScheduleRow[] = [
      {
        id: 'g1',
        seasonId: 's',
        divisionId: 'd',
        divisionName: 'U12, Boys',
        homeTeamId: 'a',
        homeTeamName: 'Rovers',
        awayTeamId: 'b',
        awayTeamName: 'Owls',
        fieldId: 'f',
        fieldName: 'Field 1',
        venueId: 'v',
        venueName: 'Park',
        timezone: 'UTC',
        startTime: new Date('2026-05-16T16:00:00.000Z'),
        durationMinutes: 60,
        status: 'scheduled',
        homeScore: null,
        awayScore: null,
        roundNumber: 1,
        notes: 'said "hello"',
        officials: [
          { id: 'o1', refereeId: 'r1', refereeName: 'Wei Chen', position: 'center', status: 'pending' },
          { id: 'o2', refereeId: 'r2', refereeName: 'Ada O', position: 'AR1', status: 'pending' },
        ],
      },
    ]
    const table = parseCsv(scheduleToCsv(rows))
    expect(table.rows[0]![table.header.indexOf('division')]).toBe('U12, Boys')
    expect(table.rows[0]![table.header.indexOf('notes')]).toBe('said "hello"')
    // Officials are semicolon-joined so a comma does not need quoting in every row.
    expect(table.rows[0]![table.header.indexOf('officials')]).toBe(
      'Wei Chen (center); Ada O (AR1)',
    )

    const assignments = parseCsv(assignmentsToCsv(rows))
    expect(assignments.rows).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Calendar feeds
// ---------------------------------------------------------------------------

describe('calendar feeds', () => {
  it('creates a URL once, serves the published schedule, and revokes', async () => {
    await gen(owner, { commit: true, config: { seed: 7, roundRobinTimes: 1 } })
    await publishCurrent()

    const created = await makeFeed(owner, { scope: 'org' })
    expect(created.status).toBe(201)
    const url: string = created.body.url
    const token = url.split('/').pop()!.replace(/\.ics$/, '')

    const feed = await fetchFeed(token)
    expect(feed.status).toBe(200)
    expect(feed.text).toContain('BEGIN:VCALENDAR')
    expect((feed.text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(6)

    // The plaintext token is never stored, so the list cannot hand it back.
    const listed = await call<{ orgId: string }>(listFeeds, `/api/orgs/${org.id}/feeds`, {
      token: owner.token,
      params: { orgId: org.id },
    })
    expect(listed.body.feeds).toHaveLength(1)
    expect(JSON.stringify(listed.body)).not.toContain(token)

    const revoked = await call<{ orgId: string; feedId: string }>(
      revokeFeed,
      `/api/orgs/${org.id}/feeds/${created.body.feed.id}`,
      {
        token: owner.token,
        method: 'DELETE',
        params: { orgId: org.id, feedId: created.body.feed.id },
      },
    )
    expect(revoked.status).toBe(200)
    expect((await fetchFeed(token)).status).toBe(404)
  })

  it('never serves a draft, even to an owner’s own feed', async () => {
    await gen(owner, { commit: true, config: { seed: 8, roundRobinTimes: 1 } })

    const created = await makeFeed(owner, { scope: 'org' })
    const token = created.body.url.split('/').pop()!.replace(/\.ics$/, '')

    // Nothing published: the feed has nothing to serve, however privileged the owner is.
    expect((await fetchFeed(token)).status).toBe(404)

    await publishCurrent()
    const published = await fetchFeed(token)
    expect((published.text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(6)

    // Regenerating the draft to twelve games must not change the feed.
    await gen(owner, { commit: true, config: { seed: 9, roundRobinTimes: 2 } })
    const after = await fetchFeed(token)
    expect((after.text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(6)
  })

  it('dies when the owner stops being a member', async () => {
    await gen(owner, { commit: true, config: { seed: 10, roundRobinTimes: 1 } })
    await publishCurrent()

    const viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)
    const created = await makeFeed(viewer, { scope: 'org' })
    const token = created.body.url.split('/').pop()!.replace(/\.ics$/, '')
    expect((await fetchFeed(token)).status).toBe(200)

    // Authorization is re-derived per fetch, so removing the membership is enough —
    // nobody has to remember the feed exists.
    await prisma.membership.updateMany({
      where: { userId: viewer.id, orgId: org.id },
      data: { deletedAt: new Date() },
    })
    expect((await fetchFeed(token)).status).toBe(404)
  })

  it('filters a team feed to that team, and a referee feed to their assignments', async () => {
    const person = await createPerson(owner, org.id, 'Wei Chen')
    const referee = await createReferee(owner, org.id, person.id)
    await gen(owner, { commit: true, config: { seed: 11, roundRobinTimes: 1 } })
    await publishCurrent()

    const teamFeed = await makeFeed(owner, { scope: 'team', teamId: teamIds[0]! })
    const teamToken = teamFeed.body.url.split('/').pop()!.replace(/\.ics$/, '')
    const teamIcs = await fetchFeed(teamToken)
    const teamEvents = (teamIcs.text.match(/BEGIN:VEVENT/g) ?? []).length
    expect(teamEvents).toBeGreaterThan(0)
    expect(teamEvents).toBeLessThan(6)

    const refFeed = await makeFeed(owner, { scope: 'referee', refereeId: referee.id })
    const refToken = refFeed.body.url.split('/').pop()!.replace(/\.ics$/, '')
    const refIcs = await fetchFeed(refToken)
    const assigned = await prisma.gameOfficial.count({
      where: { refereeId: referee.id, deletedAt: null },
    })
    expect((refIcs.text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(assigned)
  })

  it('stops a coach subscribing to a team they do not coach', async () => {
    await gen(owner, { commit: true, config: { seed: 12, roundRobinTimes: 1 } })
    await publishCurrent()

    const coach = await inviteAndAccept(owner, org.id, 'coach3@example.com', 'coach', mailer)
    const person = await createPerson(owner, org.id, 'Coach Three', { userId: coach.id })
    await prisma.teamMembership.create({
      data: { teamId: teamIds[0]!, personId: person.id, role: 'coach' },
    })

    expect((await makeFeed(coach, { scope: 'team', teamId: teamIds[0]! })).status).toBe(201)
    expect((await makeFeed(coach, { scope: 'team', teamId: teamIds[1]! })).status).toBe(403)
  })

  it('stops a referee subscribing to somebody else’s assignments', async () => {
    const own = await createPerson(owner, org.id, 'Own Official')
    const other = await createPerson(owner, org.id, 'Other Official')
    const ownReferee = await createReferee(owner, org.id, own.id)
    const otherReferee = await createReferee(owner, org.id, other.id)

    const refUser = await inviteAndAccept(owner, org.id, 'ref@example.com', 'referee', mailer)
    await prisma.person.update({ where: { id: own.id }, data: { userId: refUser.id } })

    await gen(owner, { commit: true, config: { seed: 13, roundRobinTimes: 1 } })
    await publishCurrent()

    expect((await makeFeed(refUser, { scope: 'referee' })).status).toBe(201)
    expect(
      (await makeFeed(refUser, { scope: 'referee', refereeId: ownReferee.id })).status,
    ).toBe(201)
    expect(
      (await makeFeed(refUser, { scope: 'referee', refereeId: otherReferee.id })).status,
    ).toBe(403)
  })

  it('returns the same 404 for a wrong token as for a revoked one', async () => {
    await gen(owner, { commit: true, config: { seed: 14, roundRobinTimes: 1 } })
    await publishCurrent()

    const created = await makeFeed(owner, { scope: 'org' })
    const token = created.body.url.split('/').pop()!.replace(/\.ics$/, '')
    await prisma.calendarFeed.update({
      where: { id: created.body.feed.id },
      data: { revokedAt: new Date() },
    })

    const revoked = await fetchFeed(token)
    const nonsense = await fetchFeed('not-a-real-token')
    expect(revoked.status).toBe(404)
    expect(nonsense.status).toBe(404)
    expect(revoked.text).toBe(nonsense.text)
  })

  it('does not list or let anyone revoke another member’s feed', async () => {
    await gen(owner, { commit: true, config: { seed: 15, roundRobinTimes: 1 } })
    await publishCurrent()

    const created = await makeFeed(owner, { scope: 'org' })
    const other = await inviteAndAccept(owner, org.id, 'other@example.com', 'scheduler', mailer)

    const listed = await call<{ orgId: string }>(listFeeds, `/api/orgs/${org.id}/feeds`, {
      token: other.token,
      params: { orgId: org.id },
    })
    expect(listed.body.feeds).toEqual([])

    const attempt = await call<{ orgId: string; feedId: string }>(
      revokeFeed,
      `/api/orgs/${org.id}/feeds/${created.body.feed.id}`,
      {
        token: other.token,
        method: 'DELETE',
        params: { orgId: org.id, feedId: created.body.feed.id },
      },
    )
    // 404 rather than 403: whether that id exists is not their business.
    expect(attempt.status).toBe(404)
  })

  it('records the last fetch so a dead subscription is visible', async () => {
    await gen(owner, { commit: true, config: { seed: 16, roundRobinTimes: 1 } })
    await publishCurrent()

    const created = await makeFeed(owner, { scope: 'org' })
    const token = created.body.url.split('/').pop()!.replace(/\.ics$/, '')

    expect(
      (await prisma.calendarFeed.findUniqueOrThrow({ where: { id: created.body.feed.id } }))
        .lastAccessedAt,
    ).toBeNull()

    await fetchFeed(token)
    expect(
      (await prisma.calendarFeed.findUniqueOrThrow({ where: { id: created.body.feed.id } }))
        .lastAccessedAt,
    ).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('notifications', () => {
  const prefs = (actor: TestUser) =>
    call<{ orgId: string }>(getPrefs, `/api/orgs/${org.id}/notifications`, {
      token: actor.token,
      params: { orgId: org.id },
    })

  const setPrefs = (actor: TestUser, body: Record<string, unknown>) =>
    call<{ orgId: string }>(patchPrefs, `/api/orgs/${org.id}/notifications`, {
      token: actor.token,
      method: 'PATCH',
      params: { orgId: org.id },
      body,
    })

  it('reports the defaults for a user who has never set them', async () => {
    const res = await prefs(owner)
    expect(res.status).toBe(200)
    expect(res.body.explicit).toBe(false)
    // Spelled out rather than compared against NOTIFICATION_DEFAULTS on purpose:
    // this asserts the wire contract, so adding a kind should fail here and make
    // somebody confirm the new default is the one they meant to ship.
    expect(res.body.preferences).toEqual({
      schedulePublished: true,
      gameRescheduled: true,
      assignmentChanged: true,
      rosterChanged: false,
      officiatingRequest: true,
    })
    // Reading must not create a row, or the defaults could never change later.
    expect(await prisma.notificationPreference.count()).toBe(0)
  })

  it('saves a change and records it', async () => {
    const res = await setPrefs(owner, { schedulePublished: false })
    expect(res.status).toBe(200)
    expect(res.body.preferences.schedulePublished).toBe(false)
    expect(res.body.preferences.gameRescheduled).toBe(true)

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'notifications.updated' },
    })
    const diff = event.diff as Record<string, { before: unknown; after: unknown }>
    expect(diff.schedulePublished).toEqual({ before: true, after: false })
  })

  it('emails members when a version is published, and stops for anyone who opted out', async () => {
    const coach = await inviteAndAccept(owner, org.id, 'coach4@example.com', 'coach', mailer)
    const viewer = await inviteAndAccept(owner, org.id, 'viewer2@example.com', 'viewer', mailer)
    await setPrefs(viewer, { schedulePublished: false })

    await gen(owner, { commit: true, config: { seed: 17, roundRobinTimes: 1 } })
    mailer.sent.length = 0
    await publishCurrent()

    const recipients = mailer.sent.map((mail) => mail.to)
    expect(recipients).toContain(coach.email)
    expect(recipients).toContain(owner.email)
    expect(recipients).not.toContain(viewer.email)

    const published = mailer.sent.find((mail) => mail.to === coach.email)!
    expect(published.subject).toMatch(/schedule published \(v1\)/)
    expect(published.text).toMatch(/\/s\//) // the public link is in there

    // Both the send and the suppression are on the record.
    expect(await prisma.auditEvent.count({ where: { action: 'notification.sent' } })).toBe(
      recipients.length,
    )
    const suppressed = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'notification.suppressed' },
    })
    expect((suppressed.meta as Record<string, unknown>).to).toBe(viewer.email)
  })

  it('emails a game’s staff and crew when it moves, with the old and new time', async () => {
    const coach = await inviteAndAccept(owner, org.id, 'coach5@example.com', 'coach', mailer)
    const person = await createPerson(owner, org.id, 'Coach Five', { userId: coach.id })

    await gen(owner, { commit: true, config: { seed: 18, roundRobinTimes: 1 } })
    const game = await prisma.game.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { startTime: 'asc' },
    })
    await prisma.teamMembership.create({
      data: { teamId: game.homeTeamId, personId: person.id, role: 'coach' },
    })

    mailer.sent.length = 0
    const moved = await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${game.id}`,
      {
        token: owner.token,
        method: 'PATCH',
        params: { orgId: org.id, gameId: game.id },
        body: { startTime: '2026-05-16T15:00:00.000Z' },
      },
    )
    expect(moved.status).toBe(200)

    const mail = mailer.sent.find((sent) => sent.to === coach.email)
    expect(mail).toBeDefined()
    expect(mail!.subject).toMatch(/has moved/)
    expect(mail!.text).toMatch(/Was: /)
    expect(mail!.text).toMatch(/Now: /)
    // Local time, not UTC — the venue is Pacific and 15:00Z is 8:00 AM PDT.
    expect(mail!.text).toMatch(/8:00 AM PDT/)
  })

  it('does not email for a score entry', async () => {
    const coach = await inviteAndAccept(owner, org.id, 'coach6@example.com', 'coach', mailer)
    const person = await createPerson(owner, org.id, 'Coach Six', { userId: coach.id })

    await gen(owner, { commit: true, config: { seed: 19, roundRobinTimes: 1 } })
    const game = await prisma.game.findFirstOrThrow({ where: { deletedAt: null } })
    await prisma.teamMembership.create({
      data: { teamId: game.homeTeamId, personId: person.id, role: 'coach' },
    })

    mailer.sent.length = 0
    await call<{ orgId: string; gameId: string }>(
      patchGame,
      `/api/orgs/${org.id}/games/${game.id}`,
      {
        token: owner.token,
        method: 'PATCH',
        params: { orgId: org.id, gameId: game.id },
        body: { status: 'played', homeScore: 2, awayScore: 1 },
      },
    )
    expect(mailer.sent).toEqual([])
  })

  it('emails an official when they are assigned', async () => {
    const refUser = await inviteAndAccept(owner, org.id, 'ref2@example.com', 'referee', mailer)
    const person = await createPerson(owner, org.id, 'Wei Chen', { userId: refUser.id })
    const referee = await createReferee(owner, org.id, person.id)

    await gen(owner, {
      commit: true,
      config: { seed: 20, roundRobinTimes: 1, assignOfficials: false },
    })
    const game = await prisma.game.findFirstOrThrow({ where: { deletedAt: null } })

    mailer.sent.length = 0
    const res = await call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${org.id}/games/${game.id}/officials`,
      {
        token: owner.token,
        params: { orgId: org.id, gameId: game.id },
        body: { refereeId: referee.id, position: 'center' },
      },
    )
    expect(res.status).toBe(201)

    const mail = mailer.sent.find((sent) => sent.to === refUser.email)
    expect(mail).toBeDefined()
    expect(mail!.subject).toMatch(/you are assigned to/)
    expect(mail!.text).toMatch(/assigned as center/)
    expect(mail!.text).toMatch(/Accept or decline/)
  })

  it('is off by default for roster changes, and skips the person who made the change', async () => {
    // Two staff on one team, both with logins.
    const coachA = await inviteAndAccept(owner, org.id, 'a@example.com', 'coach', mailer)
    const coachB = await inviteAndAccept(owner, org.id, 'b@example.com', 'coach', mailer)
    const personA = await createPerson(owner, org.id, 'Coach A', { userId: coachA.id })
    const personB = await createPerson(owner, org.id, 'Coach B', { userId: coachB.id })
    for (const personId of [personA.id, personB.id]) {
      await prisma.teamMembership.create({
        data: { teamId: teamIds[0]!, personId, role: 'coach' },
      })
    }
    const newPlayer = await createPerson(owner, org.id, 'New Player')

    // Default is off, so adding somebody emails nobody.
    mailer.sent.length = 0
    const addMember = (actor: TestUser) =>
      call<{ orgId: string; teamId: string }>(
        addTeamMemberRoute,
        `/api/orgs/${org.id}/teams/${teamIds[0]}/members`,
        {
          token: actor.token,
          params: { orgId: org.id, teamId: teamIds[0]! },
          body: { personId: newPlayer.id, role: 'player' },
        },
      )
    const first = await addMember(coachA)
    expect(first.status).toBe(201)
    expect(mailer.sent).toEqual([])
    // Only B is counted: A is dropped from the recipient list before preferences are
    // consulted, because A is the one who made the change.
    expect(first.body.notified).toMatchObject({ sent: 0, suppressed: 1 })

    // Turn it on for B only, then have A make a change.
    await setPrefs(coachB, { rosterChanged: true })
    const another = await createPerson(owner, org.id, 'Another Player')
    mailer.sent.length = 0
    const second = await call<{ orgId: string; teamId: string }>(
      addTeamMemberRoute,
      `/api/orgs/${org.id}/teams/${teamIds[0]}/members`,
      {
        token: coachA.token,
        params: { orgId: org.id, teamId: teamIds[0]! },
        body: { personId: another.id, role: 'player' },
      },
    )
    expect(second.status).toBe(201)

    // B is told; A is not, because A did it.
    expect(mailer.sent.map((mail) => mail.to)).toEqual([coachB.email])
    expect(mailer.sent[0]!.text).toMatch(/Another Player added as player/)
  })

  it('keeps one member out of another member’s preferences', async () => {
    const other = await inviteAndAccept(owner, org.id, 'other2@example.com', 'coach', mailer)
    await setPrefs(other, { schedulePublished: false })

    // The endpoint only ever reads or writes the caller's own row, so the owner still
    // sees their own defaults rather than the coach's choice.
    const mine = await prefs(owner)
    expect(mine.body.preferences.schedulePublished).toBe(true)
    expect(mine.body.explicit).toBe(false)
  })
})
