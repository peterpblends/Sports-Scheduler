import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  CapturingMailer,
  call,
  createOrganization,
  inviteAndAccept,
  membershipIdFor,
  resetDatabase,
  signUp,
  useCapturingMailer,
  type TestUser,
} from './helpers'

import { GET as getOrg, PATCH as patchOrg, DELETE as deleteOrg } from '@/app/api/orgs/[orgId]/route'
import { GET as listMembers, POST as inviteMember } from '@/app/api/orgs/[orgId]/members/route'
import {
  PATCH as patchMember,
  DELETE as removeMember,
} from '@/app/api/orgs/[orgId]/members/[membershipId]/route'
import { POST as acceptInvite } from '@/app/api/invitations/accept/route'
import { GET as lookupInvite } from '@/app/api/invitations/lookup/route'
import { DELETE as revokeInvite } from '@/app/api/invitations/[invitationId]/route'

let mailer: CapturingMailer
let owner: TestUser
let org: { id: string; slug: string }

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()
  owner = await signUp('owner@example.com')
  org = await createOrganization(owner, 'Riverside Youth Soccer')
})

describe('organization creation', () => {
  it('makes the creator an owner and records both audit events', async () => {
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_orgId: { userId: owner.id, orgId: org.id } },
    })
    expect(membership.role).toBe('owner')

    const actions = (
      await prisma.auditEvent.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } })
    ).map((e) => e.action)
    expect(actions).toContain('org.created')
    expect(actions).toContain('member.role_set')
  })

  it('gives each org a unique slug even with the same name', async () => {
    const second = await createOrganization(owner, 'Riverside Youth Soccer')
    expect(second.slug).not.toBe(org.slug)
  })
})

describe('tenant isolation', () => {
  it('hides an org from a non-member with 404, not 403', async () => {
    const stranger = await signUp('stranger@example.com')

    const read = await call<{ orgId: string }>(getOrg, `/api/orgs/${org.id}`, {
      token: stranger.token,
      params: { orgId: org.id },
    })
    expect(read.status).toBe(404)

    const members = await call<{ orgId: string }>(listMembers, `/api/orgs/${org.id}/members`, {
      token: stranger.token,
      params: { orgId: org.id },
    })
    expect(members.status).toBe(404)
  })

  it('requires a session on every org endpoint', async () => {
    for (const [handler, method] of [
      [getOrg, 'GET'],
      [patchOrg, 'PATCH'],
      [deleteOrg, 'DELETE'],
    ] as const) {
      const res = await call<{ orgId: string }>(handler, `/api/orgs/${org.id}`, {
        method,
        params: { orgId: org.id },
        ...(method === 'PATCH' ? { body: { name: 'Hijacked' } } : {}),
      })
      expect(res.status).toBe(401)
    }
  })
})

describe('invitation flow', () => {
  it('invites, previews, accepts, and lands the invitee at the invited role', async () => {
    const res = await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: 'sam@example.com', role: 'scheduler' },
    })
    expect(res.status).toBe(201)

    const token = mailer.tokenFromLastLink()

    const preview = await call(lookupInvite, '/api/invitations/lookup', { query: { token } })
    expect(preview.status).toBe(200)
    expect(preview.body.invitation).toMatchObject({
      email: 'sam@example.com',
      role: 'scheduler',
      orgName: 'Riverside Youth Soccer',
      hasAccount: false,
    })

    const accept = await call(acceptInvite, '/api/invitations/accept', {
      body: { token, name: 'Sam Reed', password: 'correct-horse-battery' },
    })
    expect(accept.status).toBe(200)
    expect(accept.body.role).toBe('scheduler')

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'sam@example.com' } })
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
    })
    expect(membership.role).toBe('scheduler')
  })

  it('takes the role from the invitation, not the request body', async () => {
    await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: 'sneaky@example.com', role: 'viewer' },
    })
    const token = mailer.tokenFromLastLink()

    await call(acceptInvite, '/api/invitations/accept', {
      body: { token, name: 'Sneaky', password: 'correct-horse-battery', role: 'owner' },
    })

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'sneaky@example.com' } })
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
    })
    expect(membership.role).toBe('viewer')
  })

  it('cannot be accepted twice', async () => {
    await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: 'once@example.com', role: 'viewer' },
    })
    const token = mailer.tokenFromLastLink()

    const first = await call(acceptInvite, '/api/invitations/accept', {
      body: { token, name: 'Once', password: 'correct-horse-battery' },
    })
    expect(first.status).toBe(200)

    const second = await call(acceptInvite, '/api/invitations/accept', {
      body: { token, name: 'Once', password: 'correct-horse-battery' },
    })
    expect(second.status).toBe(400)
  })

  it('rejects an expired invitation', async () => {
    await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: 'late@example.com', role: 'viewer' },
    })
    const token = mailer.tokenFromLastLink()
    await prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })

    const res = await call(acceptInvite, '/api/invitations/accept', {
      body: { token, name: 'Late', password: 'correct-horse-battery' },
    })
    expect(res.status).toBe(400)
  })

  it('refuses acceptance while signed in as a different person', async () => {
    const other = await signUp('other@example.com')
    await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: 'intended@example.com', role: 'viewer' },
    })
    const token = mailer.tokenFromLastLink()

    const res = await call(acceptInvite, '/api/invitations/accept', {
      token: other.token,
      body: { token },
    })
    expect(res.status).toBe(403)
  })

  it('lets an admin revoke a pending invitation, and a revoked one cannot be accepted', async () => {
    const created = await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: 'revoked@example.com', role: 'viewer' },
    })
    const token = mailer.tokenFromLastLink()

    const revoked = await call<{ invitationId: string }>(
      revokeInvite,
      `/api/invitations/${created.body.invitation.id}`,
      {
        method: 'DELETE',
        token: owner.token,
        params: { invitationId: created.body.invitation.id },
      },
    )
    expect(revoked.status).toBe(200)

    const accept = await call(acceptInvite, '/api/invitations/accept', {
      body: { token, name: 'Nope', password: 'correct-horse-battery' },
    })
    expect(accept.status).toBe(400)
  })

  it('rejects inviting an existing member', async () => {
    const res = await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { email: owner.email, role: 'viewer' },
    })
    expect(res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Acceptance scenario 1: a scheduler cannot change roles.
// ---------------------------------------------------------------------------

describe('scheduler restrictions', () => {
  let scheduler: TestUser
  let viewer: TestUser

  beforeEach(async () => {
    scheduler = await inviteAndAccept(owner, org.id, 'scheduler@example.com', 'scheduler', mailer)
    viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)
  })

  it('can read the member list', async () => {
    const res = await call<{ orgId: string }>(listMembers, `/api/orgs/${org.id}/members`, {
      token: scheduler.token,
      params: { orgId: org.id },
    })
    expect(res.status).toBe(200)
    expect(res.body.members).toHaveLength(3)
  })

  it('cannot change anyone’s role', async () => {
    const viewerMembership = await membershipIdFor(org.id, viewer.id)

    const res = await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${viewerMembership}`,
      {
        method: 'PATCH',
        token: scheduler.token,
        params: { orgId: org.id, membershipId: viewerMembership },
        body: { role: 'admin' },
      },
    )

    expect(res.status).toBe(403)
    const unchanged = await prisma.membership.findUniqueOrThrow({ where: { id: viewerMembership } })
    expect(unchanged.role).toBe('viewer')
  })

  it('cannot promote itself', async () => {
    const own = await membershipIdFor(org.id, scheduler.id)

    const res = await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${own}`,
      {
        method: 'PATCH',
        token: scheduler.token,
        params: { orgId: org.id, membershipId: own },
        body: { role: 'owner' },
      },
    )

    expect(res.status).toBe(403)
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: own } })).role).toBe('scheduler')
  })

  it('cannot invite, remove members, update the org, or delete it', async () => {
    const viewerMembership = await membershipIdFor(org.id, viewer.id)

    const invited = await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: scheduler.token,
      params: { orgId: org.id },
      body: { email: 'nope@example.com', role: 'viewer' },
    })
    expect(invited.status).toBe(403)

    const removed = await call<{ orgId: string; membershipId: string }>(
      removeMember,
      `/api/orgs/${org.id}/members/${viewerMembership}`,
      {
        method: 'DELETE',
        token: scheduler.token,
        params: { orgId: org.id, membershipId: viewerMembership },
      },
    )
    expect(removed.status).toBe(403)

    const updated = await call<{ orgId: string }>(patchOrg, `/api/orgs/${org.id}`, {
      method: 'PATCH',
      token: scheduler.token,
      params: { orgId: org.id },
      body: { name: 'Scheduler Was Here' },
    })
    expect(updated.status).toBe(403)

    const deleted = await call<{ orgId: string }>(deleteOrg, `/api/orgs/${org.id}`, {
      method: 'DELETE',
      token: scheduler.token,
      params: { orgId: org.id },
    })
    expect(deleted.status).toBe(403)

    // Nothing actually changed.
    const org2 = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })
    expect(org2.name).toBe('Riverside Youth Soccer')
    expect(org2.deletedAt).toBeNull()
    expect(await prisma.invitation.count({ where: { email: 'nope@example.com' } })).toBe(0)
  })
})

describe('viewer, coach and referee restrictions', () => {
  it('keeps the member list away from roles without member:read', async () => {
    const coach = await inviteAndAccept(owner, org.id, 'coach@example.com', 'coach', mailer)
    const referee = await inviteAndAccept(owner, org.id, 'ref@example.com', 'referee', mailer)
    const viewer = await inviteAndAccept(owner, org.id, 'v@example.com', 'viewer', mailer)

    for (const user of [coach, referee, viewer]) {
      const res = await call<{ orgId: string }>(listMembers, `/api/orgs/${org.id}/members`, {
        token: user.token,
        params: { orgId: org.id },
      })
      expect(res.status).toBe(403)
    }
  })

  it('lets them read the org they belong to', async () => {
    const viewer = await inviteAndAccept(owner, org.id, 'v2@example.com', 'viewer', mailer)
    const res = await call<{ orgId: string }>(getOrg, `/api/orgs/${org.id}`, {
      token: viewer.token,
      params: { orgId: org.id },
    })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('viewer')
  })
})

describe('admin limits', () => {
  it('cannot invite above its own rank, delete the org, or demote an owner', async () => {
    const admin = await inviteAndAccept(owner, org.id, 'admin@example.com', 'admin', mailer)
    const ownerMembership = await membershipIdFor(org.id, owner.id)

    // `owner` is not an invitable role at all, so this is a validation failure.
    const invited = await call<{ orgId: string }>(inviteMember, `/api/orgs/${org.id}/members`, {
      token: admin.token,
      params: { orgId: org.id },
      body: { email: 'newowner@example.com', role: 'owner' },
    })
    expect(invited.status).toBe(400)

    const deleted = await call<{ orgId: string }>(deleteOrg, `/api/orgs/${org.id}`, {
      method: 'DELETE',
      token: admin.token,
      params: { orgId: org.id },
    })
    expect(deleted.status).toBe(403)

    const demoted = await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${ownerMembership}`,
      {
        method: 'PATCH',
        token: admin.token,
        params: { orgId: org.id, membershipId: ownerMembership },
        body: { role: 'viewer' },
      },
    )
    expect(demoted.status).toBe(403)

    const promotedSelf = await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${await membershipIdFor(org.id, admin.id)}`,
      {
        method: 'PATCH',
        token: admin.token,
        params: { orgId: org.id, membershipId: await membershipIdFor(org.id, admin.id) },
        body: { role: 'owner' },
      },
    )
    expect(promotedSelf.status).toBe(403)
  })
})

describe('owner actions', () => {
  it('changes a role and writes a before/after audit diff', async () => {
    const viewer = await inviteAndAccept(owner, org.id, 'promote@example.com', 'viewer', mailer)
    const membershipId = await membershipIdFor(org.id, viewer.id)

    const res = await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${membershipId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, membershipId },
        body: { role: 'admin' },
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.member.role).toBe('admin')

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'member.role_changed', entityId: membershipId },
    })
    expect(event.diff).toEqual({ role: { before: 'viewer', after: 'admin' } })
    expect(event.actorId).toBe(owner.id)
  })

  it('refuses to leave the org without an owner', async () => {
    const membershipId = await membershipIdFor(org.id, owner.id)

    const demote = await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${membershipId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, membershipId },
        body: { role: 'admin' },
      },
    )
    expect(demote.status).toBe(403)

    const remove = await call<{ orgId: string; membershipId: string }>(
      removeMember,
      `/api/orgs/${org.id}/members/${membershipId}`,
      {
        method: 'DELETE',
        token: owner.token,
        params: { orgId: org.id, membershipId },
      },
    )
    expect(remove.status).toBe(409)
  })

  it('soft-deletes a removed member and revokes their access', async () => {
    const viewer = await inviteAndAccept(owner, org.id, 'removeme@example.com', 'viewer', mailer)
    const membershipId = await membershipIdFor(org.id, viewer.id)

    const res = await call<{ orgId: string; membershipId: string }>(
      removeMember,
      `/api/orgs/${org.id}/members/${membershipId}`,
      {
        method: 'DELETE',
        token: owner.token,
        params: { orgId: org.id, membershipId },
      },
    )
    expect(res.status).toBe(200)

    // Row is still there, just soft-deleted, and access is gone immediately.
    const membership = await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })
    expect(membership.deletedAt).not.toBeNull()

    const read = await call<{ orgId: string }>(getOrg, `/api/orgs/${org.id}`, {
      token: viewer.token,
      params: { orgId: org.id },
    })
    expect(read.status).toBe(404)
  })

  it('soft-deletes the org rather than dropping rows', async () => {
    const res = await call<{ orgId: string }>(deleteOrg, `/api/orgs/${org.id}`, {
      method: 'DELETE',
      token: owner.token,
      params: { orgId: org.id },
    })
    expect(res.status).toBe(200)

    const row = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })
    expect(row.deletedAt).not.toBeNull()
    expect(
      await prisma.auditEvent.count({ where: { orgId: org.id, action: 'org.soft_deleted' } }),
    ).toBe(1)
  })
})

describe('audit trail', () => {
  it('records an append-only event for every membership mutation', async () => {
    const member = await inviteAndAccept(owner, org.id, 'audit@example.com', 'coach', mailer)
    const membershipId = await membershipIdFor(org.id, member.id)

    await call<{ orgId: string; membershipId: string }>(
      patchMember,
      `/api/orgs/${org.id}/members/${membershipId}`,
      {
        method: 'PATCH',
        token: owner.token,
        params: { orgId: org.id, membershipId },
        body: { role: 'viewer' },
      },
    )
    await call<{ orgId: string; membershipId: string }>(
      removeMember,
      `/api/orgs/${org.id}/members/${membershipId}`,
      {
        method: 'DELETE',
        token: owner.token,
        params: { orgId: org.id, membershipId },
      },
    )

    const actions = (
      await prisma.auditEvent.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } })
    ).map((e) => e.action)

    expect(actions).toEqual([
      'org.created',
      'member.role_set',
      'invitation.created',
      'invitation.accepted',
      'member.joined',
      'member.role_changed',
      'member.removed',
    ])
  })

  it('never records an event for a rejected mutation', async () => {
    const scheduler = await inviteAndAccept(owner, org.id, 'sch2@example.com', 'scheduler', mailer)
    const before = await prisma.auditEvent.count()

    await call<{ orgId: string }>(patchOrg, `/api/orgs/${org.id}`, {
      method: 'PATCH',
      token: scheduler.token,
      params: { orgId: org.id },
      body: { name: 'Nope' },
    })

    expect(await prisma.auditEvent.count()).toBe(before)
  })
})
