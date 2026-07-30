import { prisma } from '@/lib/prisma'
import { conflict, forbidden, handler, notFound, parseBody, requirePermission } from '@/lib/http'
import { updateRoleSchema } from '@/lib/validation'
import { recordAudit } from '@/lib/audit'
import { canAssignRole, canRemoveMember } from '@/lib/authz'

type Ctx = { params: Promise<{ orgId: string; membershipId: string }> }

/**
 * Change a member's role.
 *
 * Gate 1: the caller holds `member:update_role` (owner and admin only — a
 * scheduler is rejected here with 403).
 * Gate 2: `canAssignRole` blocks escalation past the caller's own rank and
 * reserves granting/removing `owner` for owners.
 */
export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, membershipId } = await ctx.params
  const { actor, role: actorRole } = await requirePermission(req, orgId, 'member:update_role')
  const { role: nextRole } = await parseBody(req, updateRoleSchema)

  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, orgId, deletedAt: null },
    include: { user: { select: { email: true, name: true } } },
  })
  if (!membership) throw notFound('Member not found.')

  if (!canAssignRole(actorRole, membership.role, nextRole)) {
    throw forbidden('You cannot make that role change.')
  }
  if (membership.userId === actor.userId && membership.role === 'owner' && nextRole !== 'owner') {
    throw forbidden('Transfer ownership to someone else before changing your own role.')
  }
  if (membership.role === 'owner' && nextRole !== 'owner') {
    await assertNotLastOwner(orgId, membershipId)
  }
  if (membership.role === nextRole) {
    return Response.json({ member: { id: membership.id, role: membership.role } })
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.membership.update({ where: { id: membershipId }, data: { role: nextRole } })
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Membership',
        entityId: membershipId,
        action: 'member.role_changed',
        diff: { role: { before: membership.role, after: nextRole } },
        meta: { targetUserId: membership.userId, targetEmail: membership.user.email },
      },
      tx,
    )
    return result
  })

  return Response.json({ member: { id: updated.id, role: updated.role } })
})

/** Soft-remove a member from the org. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, membershipId } = await ctx.params
  const { actor, role: actorRole } = await requirePermission(req, orgId, 'member:remove')

  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, orgId, deletedAt: null },
    include: { user: { select: { email: true } } },
  })
  if (!membership) throw notFound('Member not found.')
  if (!canRemoveMember(actorRole, membership.role)) throw forbidden('You cannot remove that member.')
  if (membership.role === 'owner') await assertNotLastOwner(orgId, membershipId)

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: membershipId }, data: { deletedAt: new Date() } })
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Membership',
        entityId: membershipId,
        action: 'member.removed',
        diff: { role: { before: membership.role, after: null } },
        meta: { targetUserId: membership.userId, targetEmail: membership.user.email },
      },
      tx,
    )
  })

  return Response.json({ ok: true })
})

async function assertNotLastOwner(orgId: string, membershipId: string): Promise<void> {
  const otherOwners = await prisma.membership.count({
    where: { orgId, role: 'owner', deletedAt: null, id: { not: membershipId } },
  })
  if (otherOwners === 0) throw conflict('An organization must always have at least one owner.')
}
