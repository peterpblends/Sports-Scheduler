import { prisma } from '@/lib/prisma'
import { handler, notFound, requirePermission } from '@/lib/http'
import { recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ invitationId: string }> }

/** Revoke a pending invitation. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { invitationId } = await ctx.params

  const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } })
  if (!invitation) throw notFound('Invitation not found.')

  // Permission is checked against the invitation's own org, never a client-supplied one.
  const { actor } = await requirePermission(req, invitation.orgId, 'member:invite')

  if (invitation.acceptedAt || invitation.revokedAt) throw notFound('Invitation is no longer pending.')

  await prisma.$transaction(async (tx) => {
    await tx.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } })
    await recordAudit(
      {
        orgId: invitation.orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Invitation',
        entityId: invitationId,
        action: 'invitation.revoked',
        meta: { email: invitation.email, role: invitation.role },
      },
      tx,
    )
  })

  return Response.json({ ok: true })
})
