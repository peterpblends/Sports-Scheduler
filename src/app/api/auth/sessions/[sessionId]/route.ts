import { prisma } from '@/lib/prisma'
import { handler, notFound, requireActor } from '@/lib/http'
import { recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ sessionId: string }> }

/** Revoke one specific session belonging to the signed-in user. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const actor = await requireActor(req)
  const { sessionId } = await ctx.params

  // Scoped by userId: one user can never revoke another user's session.
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId: actor.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (result.count === 0) throw notFound('Session not found.')

  await recordAudit({
    actorId: actor.userId,
    actorLabel: actor.email,
    entityType: 'Session',
    entityId: sessionId,
    action: 'session.revoked',
  })

  return Response.json({ ok: true })
})
