import { prisma } from '@/lib/prisma'
import { forbidden, handler, parseBody, requirePermission } from '@/lib/http'
import { createAvailabilitySchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertRefereeInOrg, refereeForUser, requireAvailabilityWrite } from '@/lib/scope'
import { can } from '@/lib/authz'
import { parseCalendarDate } from '@/lib/time'
import type { RefereeAvailability } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; refereeId: string }> }

const snapshot = (a: RefereeAvailability) => ({
  kind: a.kind,
  dayOfWeek: a.dayOfWeek,
  startMinute: a.startMinute,
  endMinute: a.endMinute,
  effectiveFrom: a.effectiveFrom?.toISOString() ?? null,
  effectiveTo: a.effectiveTo?.toISOString() ?? null,
  reason: a.reason,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, refereeId } = await ctx.params
  // A referee may read their own availability; assigners may read anyone's.
  const { actor, role } = await requirePermission(req, orgId, 'org:read')
  await assertRefereeInOrg(orgId, refereeId)

  if (!can(role, 'official:read')) {
    const own = await refereeForUser(actor.userId, orgId)
    if (own?.id !== refereeId) throw forbidden('You can only view your own availability.')
  }

  const availability = await prisma.refereeAvailability.findMany({
    where: { refereeId, deletedAt: null },
    orderBy: [{ kind: 'asc' }, { dayOfWeek: 'asc' }, { effectiveFrom: 'asc' }],
  })

  return Response.json({ availability })
})

/**
 * Recurring weekly windows are stored as local-time minute offsets, not instants,
 * so "Saturdays 8am-6pm" survives a DST change. Blackouts are calendar date
 * ranges and take precedence over weekly windows.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, refereeId } = await ctx.params
  const { actor, scoped } = await requireAvailabilityWrite(req, orgId, refereeId)
  const data = await parseBody(req, createAvailabilitySchema)

  const availability = await createWithAudit({
    orgId,
    actor,
    entityType: 'RefereeAvailability',
    action: `availability.${data.kind}_added`,
    id: (a) => a.id,
    snapshot,
    meta: { refereeId, viaOwnScope: scoped },
    create: (tx) =>
      tx.refereeAvailability.create({
        data:
          data.kind === 'weekly'
            ? {
                refereeId,
                kind: 'weekly',
                dayOfWeek: data.dayOfWeek,
                startMinute: data.startTime,
                endMinute: data.endTime,
                effectiveFrom: data.effectiveFrom ? parseCalendarDate(data.effectiveFrom) : null,
                effectiveTo: data.effectiveTo ? parseCalendarDate(data.effectiveTo) : null,
                reason: data.reason ?? null,
              }
            : {
                refereeId,
                kind: 'blackout',
                effectiveFrom: parseCalendarDate(data.startDate),
                effectiveTo: parseCalendarDate(data.endDate),
                reason: data.reason ?? null,
              },
      }),
  })

  return Response.json({ availability: { id: availability.id, ...snapshot(availability) } }, { status: 201 })
})
