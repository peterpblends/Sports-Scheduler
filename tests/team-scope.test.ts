import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  CapturingMailer,
  addTeamMember,
  call,
  createDivision,
  createLeague,
  createOrganization,
  createPerson,
  createSeason,
  createTeam,
  inviteAndAccept,
  resetDatabase,
  signUp,
  useCapturingMailer,
  type TestUser,
} from './helpers'

import { PATCH as patchTeam, DELETE as deleteTeam } from '@/app/api/orgs/[orgId]/teams/[teamId]/route'
import { POST as addMember, GET as listMembers } from '@/app/api/orgs/[orgId]/teams/[teamId]/members/route'
import {
  PATCH as patchMember,
  DELETE as removeMember,
} from '@/app/api/orgs/[orgId]/teams/[teamId]/members/[membershipId]/route'
import { POST as createTeamRoute, GET as listTeams } from '@/app/api/orgs/[orgId]/teams/route'
import { POST as createPersonRoute } from '@/app/api/orgs/[orgId]/people/route'

/**
 * Non-negotiable #1: "Write a test that a `coach` token cannot mutate another
 * team's data."
 *
 * The setup is the real one: two teams in the same division of the same org, with
 * a coach user linked to a Person who is staff of team A only. Every mutation
 * below is attempted with that coach's own session token.
 */

let mailer: CapturingMailer
let owner: TestUser
let coachUser: TestUser
let org: { id: string; slug: string }
let ownTeam: { id: string; name: string }
let otherTeam: { id: string; name: string }
let coachPerson: { id: string }
let playerOnOwnTeam: { id: string }
let playerOnOtherTeam: { id: string }
let otherTeamMembershipId: string

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()

  owner = await signUp('owner@example.com')
  org = await createOrganization(owner)

  const league = await createLeague(owner, org.id)
  const season = await createSeason(owner, org.id, league.id)
  const division = await createDivision(owner, org.id, season.id)

  ownTeam = await createTeam(owner, org.id, division.id, 'Riverside Rovers')
  otherTeam = await createTeam(owner, org.id, division.id, 'Oakhurst Owls')

  // The coach's login, and the Person record that links it to a team.
  coachUser = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
  coachPerson = await createPerson(owner, org.id, 'Tom Vasquez', { userId: coachUser.id })
  await addTeamMember(owner, org.id, ownTeam.id, coachPerson.id, 'coach')

  playerOnOwnTeam = await createPerson(owner, org.id, 'Ana Ruiz')
  await addTeamMember(owner, org.id, ownTeam.id, playerOnOwnTeam.id, 'player', { jerseyNumber: '7' })

  playerOnOtherTeam = await createPerson(owner, org.id, 'Kai Bell')
  const otherMember = await addTeamMember(
    owner,
    org.id,
    otherTeam.id,
    playerOnOtherTeam.id,
    'player',
    { jerseyNumber: '9' },
  )
  otherTeamMembershipId = otherMember.id
})

describe('a coach may act on their own team', () => {
  it('adds a player to their own roster', async () => {
    const newPlayer = await createPerson(owner, org.id, 'Sam Okafor')

    const res = await call<{ orgId: string; teamId: string }>(
      addMember,
      `/api/orgs/${org.id}/teams/${ownTeam.id}/members`,
      {
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id },
        body: { personId: newPlayer.id, role: 'player', jerseyNumber: '11' },
      },
    )

    expect(res.status).toBe(201)
    const stored = await prisma.teamMembership.findUniqueOrThrow({ where: { id: res.body.member.id } })
    expect(stored.teamId).toBe(ownTeam.id)
  })

  it('edits and removes a player on their own roster', async () => {
    const membership = await prisma.teamMembership.findFirstOrThrow({
      where: { teamId: ownTeam.id, personId: playerOnOwnTeam.id, deletedAt: null },
    })

    const patched = await call<{ orgId: string; teamId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/teams/${ownTeam.id}/members/${membership.id}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id, membershipId: membership.id },
        body: { jerseyNumber: '21' },
      },
    )
    expect(patched.status).toBe(200)

    const removed = await call<{ orgId: string; teamId: string; membershipId: string }>(
      removeMember,
      `/api/orgs/${org.id}/teams/${ownTeam.id}/members/${membership.id}`,
      {
        method: 'DELETE',
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id, membershipId: membership.id },
      },
    )
    expect(removed.status).toBe(200)
    const after = await prisma.teamMembership.findUniqueOrThrow({ where: { id: membership.id } })
    expect(after.deletedAt).not.toBeNull()
  })

  it('updates their own team’s contact details', async () => {
    const res = await call<{ orgId: string; teamId: string }>(
      patchTeam,
      `/api/orgs/${org.id}/teams/${ownTeam.id}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id },
        body: { contactPhone: '555-0101' },
      },
    )
    expect(res.status).toBe(200)
  })
})

describe('a coach cannot mutate another team’s data', () => {
  it('cannot add a player to another team', async () => {
    const newPlayer = await createPerson(owner, org.id, 'Interloper')

    const res = await call<{ orgId: string; teamId: string }>(
      addMember,
      `/api/orgs/${org.id}/teams/${otherTeam.id}/members`,
      {
        token: coachUser.token,
        params: { orgId: org.id, teamId: otherTeam.id },
        body: { personId: newPlayer.id, role: 'player' },
      },
    )

    expect(res.status).toBe(403)
    expect(await prisma.teamMembership.count({ where: { teamId: otherTeam.id, deletedAt: null } })).toBe(1)
  })

  it('cannot edit a roster entry on another team', async () => {
    const res = await call<{ orgId: string; teamId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/teams/${otherTeam.id}/members/${otherTeamMembershipId}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: otherTeam.id, membershipId: otherTeamMembershipId },
        body: { jerseyNumber: '99' },
      },
    )

    expect(res.status).toBe(403)
    const unchanged = await prisma.teamMembership.findUniqueOrThrow({
      where: { id: otherTeamMembershipId },
    })
    expect(unchanged.jerseyNumber).toBe('9')
  })

  it('cannot remove a roster entry on another team', async () => {
    const res = await call<{ orgId: string; teamId: string; membershipId: string }>(
      removeMember,
      `/api/orgs/${org.id}/teams/${otherTeam.id}/members/${otherTeamMembershipId}`,
      {
        method: 'DELETE',
        token: coachUser.token,
        params: { orgId: org.id, teamId: otherTeam.id, membershipId: otherTeamMembershipId },
      },
    )

    expect(res.status).toBe(403)
    const unchanged = await prisma.teamMembership.findUniqueOrThrow({
      where: { id: otherTeamMembershipId },
    })
    expect(unchanged.deletedAt).toBeNull()
  })

  it('cannot edit another team’s details', async () => {
    const res = await call<{ orgId: string; teamId: string }>(
      patchTeam,
      `/api/orgs/${org.id}/teams/${otherTeam.id}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: otherTeam.id },
        body: { name: 'Renamed By Rival Coach' },
      },
    )

    expect(res.status).toBe(403)
    expect((await prisma.team.findUniqueOrThrow({ where: { id: otherTeam.id } })).name).toBe(
      'Oakhurst Owls',
    )
  })

  /**
   * The important one: the membership id belongs to the other team, but the URL
   * names the team the coach *does* control. If the handler trusted the id alone
   * this would succeed.
   */
  it('cannot reach another team’s roster entry through its own team’s URL', async () => {
    const res = await call<{ orgId: string; teamId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/teams/${ownTeam.id}/members/${otherTeamMembershipId}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id, membershipId: otherTeamMembershipId },
        body: { jerseyNumber: '99' },
      },
    )

    expect(res.status).toBe(404)
    const unchanged = await prisma.teamMembership.findUniqueOrThrow({
      where: { id: otherTeamMembershipId },
    })
    expect(unchanged.jerseyNumber).toBe('9')
  })

  it('cannot create or delete teams at all', async () => {
    const division = await prisma.division.findFirstOrThrow({ where: { deletedAt: null } })

    const created = await call<{ orgId: string }>(createTeamRoute, `/api/orgs/${org.id}/teams`, {
      token: coachUser.token,
      params: { orgId: org.id },
      body: { divisionId: division.id, name: 'Coach FC' },
    })
    expect(created.status).toBe(403)

    const deleted = await call<{ orgId: string; teamId: string }>(
      deleteTeam,
      `/api/orgs/${org.id}/teams/${ownTeam.id}`,
      {
        method: 'DELETE',
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id },
      },
    )
    expect(deleted.status).toBe(403)
    expect((await prisma.team.findUniqueOrThrow({ where: { id: ownTeam.id } })).deletedAt).toBeNull()
  })

  it('cannot create people org-wide', async () => {
    const res = await call<{ orgId: string }>(createPersonRoute, `/api/orgs/${org.id}/people`, {
      token: coachUser.token,
      params: { orgId: org.id },
      body: { name: 'Ghost Player' },
    })
    expect(res.status).toBe(403)
  })

  it('writes no audit event for any of the refused attempts', async () => {
    const before = await prisma.auditEvent.count()

    await call<{ orgId: string; teamId: string }>(
      addMember,
      `/api/orgs/${org.id}/teams/${otherTeam.id}/members`,
      {
        token: coachUser.token,
        params: { orgId: org.id, teamId: otherTeam.id },
        body: { personId: playerOnOwnTeam.id, role: 'player' },
      },
    )
    await call<{ orgId: string; teamId: string }>(
      patchTeam,
      `/api/orgs/${org.id}/teams/${otherTeam.id}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: otherTeam.id },
        body: { name: 'Nope' },
      },
    )

    expect(await prisma.auditEvent.count()).toBe(before)
  })
})

describe('own-team scope resolution fails closed', () => {
  it('refuses a coach with no linked Person record', async () => {
    const unlinked = await inviteAndAccept(owner, org.id, 'unlinked@example.com', 'coach', mailer)

    const res = await call<{ orgId: string; teamId: string }>(
      addMember,
      `/api/orgs/${org.id}/teams/${ownTeam.id}/members`,
      {
        token: unlinked.token,
        params: { orgId: org.id, teamId: ownTeam.id },
        body: { personId: playerOnOtherTeam.id, role: 'player' },
      },
    )
    expect(res.status).toBe(403)
  })

  it('refuses a coach whose team membership is only as a player', async () => {
    const playerUser = await inviteAndAccept(owner, org.id, 'player@example.com', 'coach', mailer)
    const person = await createPerson(owner, org.id, 'Just A Player', { userId: playerUser.id })
    await addTeamMember(owner, org.id, ownTeam.id, person.id, 'player')

    const res = await call<{ orgId: string; teamId: string }>(
      addMember,
      `/api/orgs/${org.id}/teams/${ownTeam.id}/members`,
      {
        token: playerUser.token,
        params: { orgId: org.id, teamId: ownTeam.id },
        body: { personId: playerOnOtherTeam.id, role: 'player' },
      },
    )
    expect(res.status).toBe(403)
  })

  it('stops applying once the coach is removed from the team', async () => {
    const staffRow = await prisma.teamMembership.findFirstOrThrow({
      where: { teamId: ownTeam.id, personId: coachPerson.id, role: 'coach' },
    })
    await prisma.teamMembership.update({
      where: { id: staffRow.id },
      data: { deletedAt: new Date() },
    })

    const res = await call<{ orgId: string; teamId: string }>(
      patchTeam,
      `/api/orgs/${org.id}/teams/${ownTeam.id}`,
      {
        method: 'PATCH',
        token: coachUser.token,
        params: { orgId: org.id, teamId: ownTeam.id },
        body: { contactPhone: '555-0202' },
      },
    )
    expect(res.status).toBe(403)
  })
})

describe('a coach can still read', () => {
  it('lists teams, flagging only its own as editable', async () => {
    const res = await call<{ orgId: string }>(listTeams, `/api/orgs/${org.id}/teams`, {
      token: coachUser.token,
      params: { orgId: org.id },
    })

    expect(res.status).toBe(200)
    const byName = Object.fromEntries(
      res.body.teams.map((t: { name: string; canEdit: boolean }) => [t.name, t.canEdit]),
    )
    expect(byName['Riverside Rovers']).toBe(true)
    expect(byName['Oakhurst Owls']).toBe(false)
  })

  it('reads another team’s roster without being able to change it', async () => {
    const res = await call<{ orgId: string; teamId: string }>(
      listMembers,
      `/api/orgs/${org.id}/teams/${otherTeam.id}/members`,
      { token: coachUser.token, params: { orgId: org.id, teamId: otherTeam.id } },
    )
    expect(res.status).toBe(200)
    expect(res.body.members).toHaveLength(1)
  })
})
