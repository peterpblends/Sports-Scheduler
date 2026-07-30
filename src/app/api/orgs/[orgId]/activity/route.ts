import { prisma } from '@/lib/prisma'
import { handler, requirePermission } from '@/lib/http'
import type { Prisma } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

/**
 * The global activity feed, filterable by actor, entity type and date range.
 *
 * Reads straight off `AuditEvent`, which is append-only, so this is a faithful record
 * rather than a derived summary. Scoped to the org, so one tenant's feed can never
 * surface another's.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'audit:read')

  const params = new URL(req.url).searchParams
  const actorId = params.get('actorId')
  const entityType = params.get('entityType')
  const entityId = params.get('entityId')
  const action = params.get('action')
  const from = params.get('from')
  const to = params.get('to')
  const cursor = params.get('cursor')
  const limit = Math.min(Number(params.get('limit') ?? 50) || 50, 200)

  const where: Prisma.AuditEventWhereInput = {
    orgId,
    ...(actorId ? { actorId } : {}),
    ...(entityType ? { entityType } : {}),
    ...(entityId ? { entityId } : {}),
    ...(action ? { action: { startsWith: action } } : {}),
    ...(from || to
      ? {
          createdAt: {
            // Inclusive of the whole `to` day, which is what a date picker implies.
            ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
            ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
  }

  const events = await prisma.auditEvent.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { actor: { select: { id: true, name: true, email: true } } },
  })

  const hasMore = events.length > limit
  const page = hasMore ? events.slice(0, limit) : events

  // Facets for the filter controls, so the UI does not have to guess what exists.
  const [actors, entityTypes, actions] = await Promise.all([
    prisma.auditEvent.groupBy({ by: ['actorId', 'actorLabel'], where: { orgId }, _count: true }),
    prisma.auditEvent.groupBy({ by: ['entityType'], where: { orgId }, _count: true }),
    prisma.auditEvent.groupBy({ by: ['action'], where: { orgId }, _count: true }),
  ])

  return Response.json({
    events: page.map((event) => ({
      id: event.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      actor: event.actor
        ? { id: event.actor.id, name: event.actor.name, email: event.actor.email }
        : // A removed account still has its label on the event, so history stays legible.
          { id: null, name: event.actorLabel, email: event.actorLabel },
      createdAt: event.createdAt,
      diff: event.diff,
      meta: event.meta,
    })),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    facets: {
      actors: actors
        .map((row) => ({
          id: row.actorId,
          label: row.actorLabel,
          count: row._count,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      entityTypes: entityTypes
        .map((row) => ({ value: row.entityType, count: row._count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      actions: actions
        .map((row) => ({ value: row.action, count: row._count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    },
  })
})
