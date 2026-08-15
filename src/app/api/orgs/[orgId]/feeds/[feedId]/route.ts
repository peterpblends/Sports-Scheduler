import { prisma } from '@/lib/prisma'
import { handler, notFound, requirePermission } from '@/lib/http'
import { recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string; feedId: string }> }

/**
 * Revokes a subscription URL.
 *
 * Scoped to the caller's own feeds, and a feed belonging to someone else 404s rather
 * than 403s — whether a given feed id exists is not something one member should learn
 * about another.
 *
 * Revoked rather than deleted, so the audit trail can still say which feed was turned
 * off and when.
 */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, feedId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:read:published')

  const feed = await prisma.calendarFeed.findFirst({
    where: { id: feedId, orgId, userId: actor.userId, revokedAt: null },
    select: { id: true, label: true, scope: true },
  })
  if (!feed) throw notFound('Feed not found.')

  await prisma.calendarFeed.update({
    where: { id: feed.id },
    data: { revokedAt: new Date() },
  })

  await recordAudit({
    orgId,
    actorId: actor.userId,
    actorLabel: actor.email,
    entityType: 'CalendarFeed',
    entityId: feed.id,
    action: 'feed.revoked',
    meta: { scope: feed.scope, label: feed.label },
  })

  return Response.json({ ok: true })
})
