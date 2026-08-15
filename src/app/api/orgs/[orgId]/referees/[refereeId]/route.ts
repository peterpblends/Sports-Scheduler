import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateRefereeSchema } from '@/lib/validation'
import { softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertRefereeInOrg, assertVenueInOrg } from '@/lib/scope'
import type { Referee } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; refereeId: string }> }

const snapshot = (r: Referee) => ({
  certificationLevel: r.certificationLevel,
  payRateCents: r.payRateCents,
  maxGamesPerDay: r.maxGamesPerDay,
  travelBufferMinutes: r.travelBufferMinutes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, refereeId } = await ctx.params
  await requirePermission(req, orgId, 'official:read')
  await assertRefereeInOrg(orgId, refereeId)

  const referee = await prisma.referee.findUniqueOrThrow({
    where: { id: refereeId },
    include: {
      person: true,
      preferredVenues: { select: { id: true, name: true } },
      availability: { where: { deletedAt: null }, orderBy: [{ kind: 'asc' }, { dayOfWeek: 'asc' }] },
    },
  })

  return Response.json({ referee })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, refereeId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const before = await assertRefereeInOrg(orgId, refereeId)
  const patch = await parseBody(req, updateRefereeSchema)

  for (const venueId of patch.preferredVenueIds ?? []) await assertVenueInOrg(orgId, venueId)

  const referee = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Referee',
    entityId: refereeId,
    before: snapshot(before),
    snapshot,
    update: (tx) =>
      tx.referee.update({
        where: { id: refereeId },
        data: {
          ...(patch.certificationLevel !== undefined
            ? { certificationLevel: patch.certificationLevel ?? null }
            : {}),
          ...(patch.payRateCents !== undefined ? { payRateCents: patch.payRateCents ?? null } : {}),
          ...(patch.maxGamesPerDay !== undefined ? { maxGamesPerDay: patch.maxGamesPerDay } : {}),
          ...(patch.travelBufferMinutes !== undefined
            ? { travelBufferMinutes: patch.travelBufferMinutes }
            : {}),
          ...(patch.preferredVenueIds !== undefined
            ? { preferredVenues: { set: patch.preferredVenueIds.map((id) => ({ id })) } }
            : {}),
        },
      }),
  })

  return Response.json({ referee: { id: referee.id, ...snapshot(referee) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, refereeId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  await assertRefereeInOrg(orgId, refereeId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Referee',
    entityId: refereeId,
    softDelete: (tx, deletedAt) =>
      tx.referee.updateMany({ where: { id: refereeId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
