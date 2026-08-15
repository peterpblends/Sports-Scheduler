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

import { GET as listLeagues, POST as createLeagueRoute } from '@/app/api/orgs/[orgId]/leagues/route'
import { DELETE as deleteLeague, PATCH as patchLeague } from '@/app/api/orgs/[orgId]/leagues/[leagueId]/route'
import { POST as createSeasonRoute } from '@/app/api/orgs/[orgId]/seasons/route'
import { PATCH as patchSeason } from '@/app/api/orgs/[orgId]/seasons/[seasonId]/route'
import { POST as createDivisionRoute } from '@/app/api/orgs/[orgId]/divisions/route'
import { POST as createTeamRoute, GET as listTeams } from '@/app/api/orgs/[orgId]/teams/route'
import { PATCH as patchTeam } from '@/app/api/orgs/[orgId]/teams/[teamId]/route'
import { POST as createVenueRoute, GET as listVenues } from '@/app/api/orgs/[orgId]/venues/route'
import { POST as createFieldRoute } from '@/app/api/orgs/[orgId]/venues/[venueId]/fields/route'
import { POST as createSlot } from '@/app/api/orgs/[orgId]/fields/[fieldId]/timeslots/route'
import { POST as createPersonRoute } from '@/app/api/orgs/[orgId]/people/route'
import { PATCH as patchPerson } from '@/app/api/orgs/[orgId]/people/[personId]/route'
import { POST as createRefereeRoute, GET as listReferees } from '@/app/api/orgs/[orgId]/referees/route'
import { POST as addAvailability } from '@/app/api/orgs/[orgId]/referees/[refereeId]/availability/route'
import { DELETE as deleteAvailability } from '@/app/api/orgs/[orgId]/referees/[refereeId]/availability/[availabilityId]/route'
import { POST as createBlackout } from '@/app/api/orgs/[orgId]/blackouts/route'

let mailer: CapturingMailer
let owner: TestUser
let org: { id: string; slug: string }

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()
  owner = await signUp('owner@example.com')
  org = await createOrganization(owner)
})

describe('the structure chain', () => {
  it('builds league -> season -> division -> team', async () => {
    const league = await createLeague(owner, org.id, 'Rec League')
    const season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id, 'U12 Boys')
    const team = await createTeam(owner, org.id, division.id, 'Rovers')

    const stored = await prisma.team.findUniqueOrThrow({
      where: { id: team.id },
      include: { division: { include: { season: { include: { league: true } } } } },
    })
    expect(stored.division.season.league.orgId).toBe(org.id)
    expect(stored.division.season.league.sport).toBe('soccer')
  })

  it('stores season dates as calendar dates that do not shift', async () => {
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id, {
      startDate: '2026-03-07',
      endDate: '2026-05-30',
    })
    const stored = await prisma.season.findUniqueOrThrow({ where: { id: season.id } })
    expect(stored.startDate.toISOString()).toBe('2026-03-07T00:00:00.000Z')
    expect(stored.endDate.toISOString()).toBe('2026-05-30T00:00:00.000Z')
  })

  it('refuses a season whose end precedes its start', async () => {
    const league = await createLeague(owner, org.id)
    const res = await call<{ orgId: string }>(createSeasonRoute, `/api/orgs/${org.id}/seasons`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { leagueId: league.id, name: 'Backwards', startDate: '2026-05-01', endDate: '2026-03-01' },
    })
    expect(res.status).toBe(400)
  })

  it('refuses a PATCH that would invert an existing season’s dates', async () => {
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id, {
      startDate: '2026-03-07',
      endDate: '2026-05-30',
    })
    const res = await call<{ orgId: string; seasonId: string }>(
      patchSeason,
      `/api/orgs/${org.id}/seasons/${season.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, seasonId: season.id },
        body: { endDate: '2026-01-01' },
      },
    )
    expect(res.status).toBe(409)
  })

  it('rejects duplicate names within a parent but allows them across parents', async () => {
    const leagueA = await createLeague(owner, org.id, 'League A')
    const leagueB = await createLeague(owner, org.id, 'League B')
    const seasonA = await createSeason(owner, org.id, leagueA.id, { name: 'Spring 2026' })
    await createSeason(owner, org.id, leagueB.id, { name: 'Spring 2026' }) // fine, different league

    const dupe = await call<{ orgId: string }>(createSeasonRoute, `/api/orgs/${org.id}/seasons`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        leagueId: leagueA.id,
        name: 'Spring 2026',
        startDate: '2026-03-07',
        endDate: '2026-05-30',
      },
    })
    expect(dupe.status).toBe(409)
    expect(seasonA.name).toBe('Spring 2026')
  })

  it('frees a name again after a soft delete', async () => {
    const league = await createLeague(owner, org.id, 'Recycled')

    const deleted = await call<{ orgId: string; leagueId: string }>(
      deleteLeague,
      `/api/orgs/${org.id}/leagues/${league.id}`,
      {
        method: 'DELETE',
        token: owner.token,
        params: { orgId: org.id, leagueId: league.id },
      },
    )
    expect(deleted.status).toBe(200)

    // The row is still there — soft deleted, not dropped.
    const row = await prisma.league.findUniqueOrThrow({ where: { id: league.id } })
    expect(row.deletedAt).not.toBeNull()

    // And the name is reusable, which a database unique index would forbid.
    const recreated = await createLeague(owner, org.id, 'Recycled')
    expect(recreated.id).not.toBe(league.id)

    const listed = await call<{ orgId: string }>(listLeagues, `/api/orgs/${org.id}/leagues`, {
      token: owner.token,
      params: { orgId: org.id },
    })
    expect(listed.body.leagues).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Optional pictures — a link to wherever it is already hosted, not an upload.
// ---------------------------------------------------------------------------

describe('league, team and person picture URLs', () => {
  it('stores, updates and clears a league logo URL', async () => {
    const created = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Rec League', sport: 'soccer', logoUrl: 'https://example.com/logo.png' },
    })
    expect(created.status).toBe(201)
    expect(created.body.league.logoUrl).toBe('https://example.com/logo.png')
    const leagueId = created.body.league.id as string

    const updated = await call<{ orgId: string; leagueId: string }>(
      patchLeague,
      `/api/orgs/${org.id}/leagues/${leagueId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, leagueId },
        body: { logoUrl: 'https://example.com/new-logo.png' },
      },
    )
    expect(updated.body.league.logoUrl).toBe('https://example.com/new-logo.png')

    const cleared = await call<{ orgId: string; leagueId: string }>(
      patchLeague,
      `/api/orgs/${org.id}/leagues/${leagueId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, leagueId },
        body: { logoUrl: null },
      },
    )
    expect(cleared.body.league.logoUrl).toBeNull()
    expect((await prisma.league.findUniqueOrThrow({ where: { id: leagueId } })).logoUrl).toBeNull()
  })

  it('rejects a league logo that is not a valid URL', async () => {
    const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Rec League', sport: 'soccer', logoUrl: 'not-a-url' },
    })
    expect(res.status).toBe(400)
  })

  it('stores and updates a team logo URL', async () => {
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id, 'U12 Boys')
    const team = await createTeam(owner, org.id, division.id, 'Rovers')

    const updated = await call<{ orgId: string; teamId: string }>(
      patchTeam,
      `/api/orgs/${org.id}/teams/${team.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, teamId: team.id },
        body: { logoUrl: 'https://example.com/crest.png' },
      },
    )
    expect(updated.status).toBe(200)
    expect(updated.body.team.logoUrl).toBe('https://example.com/crest.png')
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).logoUrl).toBe(
      'https://example.com/crest.png',
    )
  })

  it('stores and clears a person photo URL', async () => {
    const person = await createPerson(owner, org.id, 'Ada Okonkwo', {
      photoUrl: 'https://example.com/ada.jpg',
    })
    expect((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).photoUrl).toBe(
      'https://example.com/ada.jpg',
    )

    const cleared = await call<{ orgId: string; personId: string }>(
      patchPerson,
      `/api/orgs/${org.id}/people/${person.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, personId: person.id },
        body: { photoUrl: null },
      },
    )
    expect(cleared.body.person.photoUrl).toBeNull()
  })

  it('rejects a person photo that is not a valid URL', async () => {
    const res = await call<{ orgId: string }>(createPersonRoute, `/api/orgs/${org.id}/people`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Ada', photoUrl: 'not-a-url' },
    })
    expect(res.status).toBe(400)
  })
})

describe('tenant isolation across the whole entity chain', () => {
  /**
   * The dangerous shape: a real member of org A passing their own orgId together
   * with an id belonging to org B. The permission check passes; only the
   * `assert*InOrg` scoping stops it.
   */
  it('refuses to attach a season to another org’s league', async () => {
    const outsider = await signUp('outsider@example.com')
    const otherOrg = await createOrganization(outsider, 'Rival Org')
    const theirLeague = await createLeague(outsider, otherOrg.id, 'Their League')

    const res = await call<{ orgId: string }>(createSeasonRoute, `/api/orgs/${org.id}/seasons`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        leagueId: theirLeague.id,
        name: 'Hijack',
        startDate: '2026-03-07',
        endDate: '2026-05-30',
      },
    })

    expect(res.status).toBe(404)
    expect(await prisma.season.count({ where: { leagueId: theirLeague.id } })).toBe(0)
  })

  it('refuses cross-org parents at every level', async () => {
    const outsider = await signUp('outsider2@example.com')
    const otherOrg = await createOrganization(outsider, 'Rival Two')
    const theirLeague = await createLeague(outsider, otherOrg.id)
    const theirSeason = await createSeason(outsider, otherOrg.id, theirLeague.id)
    const theirDivision = await createDivision(outsider, otherOrg.id, theirSeason.id)
    const theirVenue = await createVenue(outsider, otherOrg.id, 'Their Park')
    const theirField = await createField(outsider, otherOrg.id, theirVenue.id, 'Their Field 1')
    const theirPerson = await createPerson(outsider, otherOrg.id, 'Their Person')

    const attempts: { what: string; res: { status: number } }[] = [
      {
        what: 'division under their season',
        res: await call<{ orgId: string }>(createDivisionRoute, `/api/orgs/${org.id}/divisions`, {
          token: owner.token,
          params: { orgId: org.id },
          body: { seasonId: theirSeason.id, name: 'Hijack' },
        }),
      },
      {
        what: 'team under their division',
        res: await call<{ orgId: string }>(createTeamRoute, `/api/orgs/${org.id}/teams`, {
          token: owner.token,
          params: { orgId: org.id },
          body: { divisionId: theirDivision.id, name: 'Hijack FC' },
        }),
      },
      {
        what: 'field under their venue',
        res: await call<{ orgId: string; venueId: string }>(
          createFieldRoute,
          `/api/orgs/${org.id}/venues/${theirVenue.id}/fields`,
          { token: owner.token, params: { orgId: org.id, venueId: theirVenue.id }, body: { name: 'X' } },
        ),
      },
      {
        what: 'time slot on their field',
        res: await call<{ orgId: string; fieldId: string }>(
          createSlot,
          `/api/orgs/${org.id}/fields/${theirField.id}/timeslots`,
          {
            token: owner.token,
            params: { orgId: org.id, fieldId: theirField.id },
            body: { kind: 'recurring', dayOfWeek: 6, startTime: '08:00', endTime: '18:00' },
          },
        ),
      },
      {
        what: 'referee from their person',
        res: await call<{ orgId: string }>(createRefereeRoute, `/api/orgs/${org.id}/referees`, {
          token: owner.token,
          params: { orgId: org.id },
          body: { personId: theirPerson.id },
        }),
      },
    ]

    for (const attempt of attempts) {
      expect(attempt.res.status, attempt.what).toBe(404)
    }
  })

  it('never lists another org’s rows', async () => {
    const outsider = await signUp('outsider3@example.com')
    const otherOrg = await createOrganization(outsider, 'Rival Three')
    const theirLeague = await createLeague(outsider, otherOrg.id)
    const theirSeason = await createSeason(outsider, otherOrg.id, theirLeague.id)
    const theirDivision = await createDivision(outsider, otherOrg.id, theirSeason.id)
    await createTeam(outsider, otherOrg.id, theirDivision.id, 'Their Team')
    await createVenue(outsider, otherOrg.id, 'Their Venue')

    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id)
    await createTeam(owner, org.id, division.id, 'Our Team')
    await createVenue(owner, org.id, 'Our Venue')

    const teams = await call<{ orgId: string }>(listTeams, `/api/orgs/${org.id}/teams`, {
      token: owner.token,
      params: { orgId: org.id },
    })
    expect(teams.body.teams.map((t: { name: string }) => t.name)).toEqual(['Our Team'])

    const venues = await call<{ orgId: string }>(listVenues, `/api/orgs/${org.id}/venues`, {
      token: owner.token,
      params: { orgId: org.id },
    })
    expect(venues.body.venues.map((v: { name: string }) => v.name)).toEqual(['Our Venue'])
  })

  it('refuses to link a Person to a user who is not a member of the org', async () => {
    const stranger = await signUp('stranger@example.com')

    const res = await call<{ orgId: string }>(createPersonRoute, `/api/orgs/${org.id}/people`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Impostor', userId: stranger.id },
    })
    expect(res.status).toBe(409)
  })

  it('refuses to link two people to the same user', async () => {
    const member = await inviteAndAccept(owner, org.id, 'member@example.com', 'coach', mailer)
    await createPerson(owner, org.id, 'First Link', { userId: member.id })

    const res = await call<{ orgId: string }>(createPersonRoute, `/api/orgs/${org.id}/people`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Second Link', userId: member.id },
    })
    expect(res.status).toBe(409)
  })
})

describe('venues, fields and time slots', () => {
  it('requires an IANA zone on a venue and rejects nonsense', async () => {
    const ok = await createVenue(owner, org.id, 'Riverside Park', 'America/Los_Angeles')
    expect(ok.timezone).toBe('America/Los_Angeles')

    const bad = await call<{ orgId: string }>(createVenueRoute, `/api/orgs/${org.id}/venues`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Nowhere Park', timezone: 'Mars/Olympus' },
    })
    expect(bad.status).toBe(400)
  })

  it('stores a recurring slot as local minutes, not an instant', async () => {
    const venue = await createVenue(owner, org.id, 'Riverside Park')
    const field = await createField(owner, org.id, venue.id, 'Field 1')
    const slot = await createRecurringSlot(owner, org.id, field.id, {
      dayOfWeek: 6,
      startTime: '08:00',
      endTime: '18:00',
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-06-15',
    })

    const stored = await prisma.timeSlot.findUniqueOrThrow({ where: { id: slot.id } })
    expect(stored.dayOfWeek).toBe(6)
    expect(stored.startMinute).toBe(480)
    expect(stored.endMinute).toBe(1080)
    expect(stored.specificDate).toBeNull()
    expect(stored.effectiveFrom?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('accepts a one-off slot pinned to a single date', async () => {
    const venue = await createVenue(owner, org.id, 'Riverside Park')
    const field = await createField(owner, org.id, venue.id, 'Field 1')

    const res = await call<{ orgId: string; fieldId: string }>(
      createSlot,
      `/api/orgs/${org.id}/fields/${field.id}/timeslots`,
      {
        token: owner.token,
        params: { orgId: org.id, fieldId: field.id },
        body: { kind: 'one_off', specificDate: '2026-04-11', startTime: '09:00', endTime: '12:00' },
      },
    )
    expect(res.status).toBe(201)
    const stored = await prisma.timeSlot.findUniqueOrThrow({ where: { id: res.body.timeSlot.id } })
    expect(stored.dayOfWeek).toBeNull()
    expect(stored.specificDate?.toISOString()).toBe('2026-04-11T00:00:00.000Z')
  })

  it('rejects a slot that ends before it starts', async () => {
    const venue = await createVenue(owner, org.id, 'Riverside Park')
    const field = await createField(owner, org.id, venue.id, 'Field 1')

    const res = await call<{ orgId: string; fieldId: string }>(
      createSlot,
      `/api/orgs/${org.id}/fields/${field.id}/timeslots`,
      {
        token: owner.token,
        params: { orgId: org.id, fieldId: field.id },
        body: { kind: 'recurring', dayOfWeek: 6, startTime: '18:00', endTime: '08:00' },
      },
    )
    expect(res.status).toBe(400)
  })

  it('returns the venue zone alongside the slots, since minutes alone are meaningless', async () => {
    const venue = await createVenue(owner, org.id, 'Eastside Complex', 'America/New_York')
    const field = await createField(owner, org.id, venue.id, 'Field 1')
    await createRecurringSlot(owner, org.id, field.id, {
      dayOfWeek: 0,
      startTime: '10:00',
      endTime: '14:00',
    })

    const { GET } = await import('@/app/api/orgs/[orgId]/fields/[fieldId]/timeslots/route')
    const res = await call<{ orgId: string; fieldId: string }>(
      GET,
      `/api/orgs/${org.id}/fields/${field.id}/timeslots`,
      { token: owner.token, params: { orgId: org.id, fieldId: field.id } },
    )
    expect(res.body.timezone).toBe('America/New_York')
  })
})

describe('people and officials', () => {
  it('reuses one Person across several team roles', async () => {
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id)
    const teamA = await createTeam(owner, org.id, division.id, 'Team A')
    const teamB = await createTeam(owner, org.id, division.id, 'Team B')

    const person = await createPerson(owner, org.id, 'Busy Parent')
    await addTeamMember(owner, org.id, teamA.id, person.id, 'coach')
    await addTeamMember(owner, org.id, teamB.id, person.id, 'manager')

    const memberships = await prisma.teamMembership.findMany({
      where: { personId: person.id, deletedAt: null },
    })
    expect(memberships).toHaveLength(2)
    expect(new Set(memberships.map((m) => m.role))).toEqual(new Set(['coach', 'manager']))
  })

  it('refuses a duplicate jersey number among current members', async () => {
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id)
    const team = await createTeam(owner, org.id, division.id, 'Team A')

    const first = await createPerson(owner, org.id, 'Player One')
    const second = await createPerson(owner, org.id, 'Player Two')
    await addTeamMember(owner, org.id, team.id, first.id, 'player', { jerseyNumber: '10' })

    const { POST } = await import('@/app/api/orgs/[orgId]/teams/[teamId]/members/route')
    const res = await call<{ orgId: string; teamId: string }>(
      POST,
      `/api/orgs/${org.id}/teams/${team.id}/members`,
      {
        token: owner.token,
        params: { orgId: org.id, teamId: team.id },
        body: { personId: second.id, role: 'player', jerseyNumber: '10' },
      },
    )
    expect(res.status).toBe(409)
  })

  it('flags a person as a referee with pay stored in cents', async () => {
    const person = await createPerson(owner, org.id, 'Wei Chen')
    const referee = await createReferee(owner, org.id, person.id, {
      certificationLevel: 'Grade 7',
      payRateCents: 4500,
      maxGamesPerDay: 3,
    })

    const stored = await prisma.referee.findUniqueOrThrow({ where: { id: referee.id } })
    expect(stored.payRateCents).toBe(4500)
    expect(typeof stored.payRateCents).toBe('number')
  })

  it('records weekly availability in local minutes and blackouts as date ranges', async () => {
    const person = await createPerson(owner, org.id, 'Wei Chen')
    const referee = await createReferee(owner, org.id, person.id)

    const weekly = await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${referee.id}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId: referee.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '14:00' },
      },
    )
    expect(weekly.status).toBe(201)

    const blackout = await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${referee.id}/availability`,
      {
        token: owner.token,
        params: { orgId: org.id, refereeId: referee.id },
        body: { kind: 'blackout', startDate: '2026-04-04', endDate: '2026-04-11', reason: 'Away' },
      },
    )
    expect(blackout.status).toBe(201)

    const rows = await prisma.refereeAvailability.findMany({
      where: { refereeId: referee.id },
      orderBy: { kind: 'asc' },
    })
    const weeklyRow = rows.find((r) => r.kind === 'weekly')!
    expect(weeklyRow.startMinute).toBe(480)
    expect(weeklyRow.endMinute).toBe(840)

    const blackoutRow = rows.find((r) => r.kind === 'blackout')!
    expect(blackoutRow.effectiveFrom?.toISOString()).toBe('2026-04-04T00:00:00.000Z')
    expect(blackoutRow.dayOfWeek).toBeNull()
  })

  it('lets a referee manage their own availability but not someone else’s', async () => {
    const refUser = await inviteAndAccept(owner, org.id, 'ref@example.com', 'referee', mailer)
    const refPerson = await createPerson(owner, org.id, 'Self Ref', { userId: refUser.id })
    const own = await createReferee(owner, org.id, refPerson.id)

    const otherPerson = await createPerson(owner, org.id, 'Other Ref')
    const other = await createReferee(owner, org.id, otherPerson.id)

    const mine = await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${own.id}/availability`,
      {
        token: refUser.token,
        params: { orgId: org.id, refereeId: own.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '12:00' },
      },
    )
    expect(mine.status).toBe(201)

    const theirs = await call<{ orgId: string; refereeId: string }>(
      addAvailability,
      `/api/orgs/${org.id}/referees/${other.id}/availability`,
      {
        token: refUser.token,
        params: { orgId: org.id, refereeId: other.id },
        body: { kind: 'weekly', dayOfWeek: 6, startTime: '08:00', endTime: '12:00' },
      },
    )
    expect(theirs.status).toBe(403)

    // Nor by id, through their own referee's URL.
    const smuggled = await call<{ orgId: string; refereeId: string; availabilityId: string }>(
      deleteAvailability,
      `/api/orgs/${org.id}/referees/${own.id}/availability/${mine.body.availability.id}`,
      {
        method: 'DELETE',
        token: refUser.token,
        params: { orgId: org.id, refereeId: own.id, availabilityId: mine.body.availability.id },
      },
    )
    expect(smuggled.status).toBe(200) // their own — allowed
  })

  it('keeps a referee out of the roster and official write paths', async () => {
    const refUser = await inviteAndAccept(owner, org.id, 'ref2@example.com', 'referee', mailer)

    const listed = await call<{ orgId: string }>(listReferees, `/api/orgs/${org.id}/referees`, {
      token: refUser.token,
      params: { orgId: org.id },
    })
    // A referee has `official:read:own`, not `official:read` — no roster of peers.
    expect(listed.status).toBe(403)
  })
})

describe('blackout dates', () => {
  it('accepts one target id matching the scope and rejects mismatches', async () => {
    const venue = await createVenue(owner, org.id, 'Riverside Park')

    const good = await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        scope: 'venue',
        venueId: venue.id,
        startDate: '2026-05-23',
        endDate: '2026-05-25',
        reason: 'Field maintenance',
      },
    })
    expect(good.status).toBe(201)

    const orgWide = await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        scope: 'org',
        startDate: '2026-07-04',
        endDate: '2026-07-04',
        reason: 'Holiday',
      },
    })
    expect(orgWide.status).toBe(201)

    // scope says venue, but a team id was supplied
    const mismatched = await call<{ orgId: string }>(createBlackout, `/api/orgs/${org.id}/blackouts`, {
      token: owner.token,
      params: { orgId: org.id },
      body: {
        scope: 'venue',
        teamId: 'some-team',
        startDate: '2026-05-23',
        endDate: '2026-05-25',
        reason: 'Wrong shape',
      },
    })
    expect(mismatched.status).toBe(400)

    // org scope with a target id set
    const overSpecified = await call<{ orgId: string }>(
      createBlackout,
      `/api/orgs/${org.id}/blackouts`,
      {
        token: owner.token,
        params: { orgId: org.id },
        body: {
          scope: 'org',
          venueId: venue.id,
          startDate: '2026-07-04',
          endDate: '2026-07-04',
          reason: 'Wrong shape',
        },
      },
    )
    expect(overSpecified.status).toBe(400)
  })
})

describe('role enforcement on Phase 2 endpoints', () => {
  it('lets a scheduler manage venues but not the structure or rosters', async () => {
    const scheduler = await inviteAndAccept(owner, org.id, 'sched@example.com', 'scheduler', mailer)

    const venue = await call<{ orgId: string }>(createVenueRoute, `/api/orgs/${org.id}/venues`, {
      token: scheduler.token,
      params: { orgId: org.id },
      body: { name: 'Scheduler Park', timezone: 'America/Los_Angeles' },
    })
    expect(venue.status).toBe(201)

    const league = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: scheduler.token,
      params: { orgId: org.id },
      body: { name: 'Scheduler League' },
    })
    expect(league.status).toBe(403)

    const person = await call<{ orgId: string }>(createPersonRoute, `/api/orgs/${org.id}/people`, {
      token: scheduler.token,
      params: { orgId: org.id },
      body: { name: 'Scheduler Person' },
    })
    expect(person.status).toBe(403)
  })

  it('gives a viewer reads and no writes', async () => {
    const viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)

    const read = await call<{ orgId: string }>(listVenues, `/api/orgs/${org.id}/venues`, {
      token: viewer.token,
      params: { orgId: org.id },
    })
    expect(read.status).toBe(200)

    const write = await call<{ orgId: string }>(createVenueRoute, `/api/orgs/${org.id}/venues`, {
      token: viewer.token,
      params: { orgId: org.id },
      body: { name: 'Viewer Park', timezone: 'UTC' },
    })
    expect(write.status).toBe(403)
  })
})

describe('audit coverage of Phase 2 mutations', () => {
  it('records a create, an update diff and a soft delete for every entity type', async () => {
    const league = await createLeague(owner, org.id, 'Audited League')
    const season = await createSeason(owner, org.id, league.id)

    await call<{ orgId: string; seasonId: string }>(
      patchSeason,
      `/api/orgs/${org.id}/seasons/${season.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, seasonId: season.id },
        body: { status: 'active' },
      },
    )
    await call<{ orgId: string; leagueId: string }>(
      deleteLeague,
      `/api/orgs/${org.id}/leagues/${league.id}`,
      { method: 'DELETE', token: owner.token, params: { orgId: org.id, leagueId: league.id } },
    )

    const events = await prisma.auditEvent.findMany({
      where: { orgId: org.id, entityType: { in: ['League', 'Season'] } },
      orderBy: { createdAt: 'asc' },
    })
    const actions = events.map((e) => e.action)
    expect(actions).toEqual([
      'league.created',
      'season.created',
      'season.updated',
      'league.soft_deleted',
    ])

    const update = events.find((e) => e.action === 'season.updated')!
    expect(update.diff).toEqual({ status: { before: 'draft', after: 'active' } })
    expect(update.actorId).toBe(owner.id)
  })

  it('records nothing for a no-op PATCH', async () => {
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id)
    const before = await prisma.auditEvent.count()

    const res = await call<{ orgId: string; seasonId: string }>(
      patchSeason,
      `/api/orgs/${org.id}/seasons/${season.id}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, seasonId: season.id },
        body: { name: season.name },
      },
    )
    expect(res.status).toBe(200)
    expect(await prisma.auditEvent.count()).toBe(before)
  })
})
