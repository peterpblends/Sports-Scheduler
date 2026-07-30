import { prisma } from '@/lib/prisma'
import { handler, requireActor } from '@/lib/http'
import { revokeAllSessions } from '@/lib/session'
import { recordAudit } from '@/lib/audit'

/** Active sessions for the signed-in user. */
export const GET = handler(async (req) => {
  const actor = await requireActor(req)
  const sessions = await prisma.session.findMany({
    where: { userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeen: 'desc' },
    select: { id: true, createdAt: true, lastSeen: true, expiresAt: true, userAgent: true, ip: true },
  })
  return Response.json({
    sessions: sessions.map((s) => ({ ...s, current: s.id === actor.sessionId })),
  })
})

/** Sign out everywhere else. */
export const DELETE = handler(async (req) => {
  const actor = await requireActor(req)
  const count = await revokeAllSessions(actor.userId, actor.sessionId)
  await recordAudit({
    actorId: actor.userId,
    actorLabel: actor.email,
    entityType: 'User',
    entityId: actor.userId,
    action: 'user.sessions_revoked',
    meta: { revoked: count, keptSessionId: actor.sessionId },
  })
  return Response.json({ revoked: count })
})
