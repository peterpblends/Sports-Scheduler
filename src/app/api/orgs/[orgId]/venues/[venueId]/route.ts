import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateVenueSchema } from '@/lib/validation'
import { assertNameAvailable, softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertVenueInOrg } from '@/lib/scope'
import type { Venue } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; venueId: string }> }

const snapshot = (v: Venue) => ({
  name: v.name,
  address: v.address,
  timezone: v.timezone,
  notes: v.notes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, venueId } = await ctx.params
  await requirePermission(req, orgId, 'venue:read')
  const venue = await assertVenueInOrg(orgId, venueId)

  const fields = await prisma.field.findMany({
    where: { venueId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: {
      timeSlots: { where: { deletedAt: null }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
    },
  })

  return Response.json({ venue: { id: venue.id, ...snapshot(venue) }, fields })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, venueId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  const before = await assertVenueInOrg(orgId, venueId)
  const patch = await parseBody(req, updateVenueSchema)

  if (patch.name && patch.name !== before.name) {
    await assertNameAvailable({
      delegate: prisma.venue,
      where: { orgId, name: patch.name },
      label: 'A venue with that name already exists.',
      exceptId: venueId,
    })
  }

  const venue = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Venue',
    entityId: venueId,
    before: snapshot(before),
    snapshot,
    // Changing a venue's zone re-renders every game there. The audit diff records
    // the before/after so the shift is traceable.
    meta: patch.timezone && patch.timezone !== before.timezone ? { timezoneChanged: true } : undefined,
    update: (tx) =>
      tx.venue.update({
        where: { id: venueId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.address !== undefined ? { address: patch.address ?? null } : {}),
          ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
        },
      }),
  })

  return Response.json({ venue: { id: venue.id, ...snapshot(venue) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, venueId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  await assertVenueInOrg(orgId, venueId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Venue',
    entityId: venueId,
    softDelete: (tx, deletedAt) =>
      tx.venue.updateMany({ where: { id: venueId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
