import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createVenueSchema } from '@/lib/validation'
import { assertNameAvailable, createWithAudit } from '@/lib/crud'
import type { Venue } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (v: Venue) => ({
  name: v.name,
  address: v.address,
  timezone: v.timezone,
  notes: v.notes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'venue:read')

  const venues = await prisma.venue.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: {
      fields: {
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
        include: {
          timeSlots: { where: { deletedAt: null }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
        },
      },
    },
  })

  return Response.json({
    venues: venues.map((v) => ({
      id: v.id,
      ...snapshot(v),
      fields: v.fields.map((f) => ({
        id: f.id,
        name: f.name,
        notes: f.notes,
        timeSlots: f.timeSlots,
      })),
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  const data = await parseBody(req, createVenueSchema)

  await assertNameAvailable({
    delegate: prisma.venue,
    where: { orgId, name: data.name },
    label: 'A venue with that name already exists.',
  })

  const venue = await createWithAudit({
    orgId,
    actor,
    entityType: 'Venue',
    id: (v) => v.id,
    snapshot,
    create: (tx) =>
      tx.venue.create({
        data: {
          orgId,
          name: data.name,
          address: data.address ?? null,
          // Every game at this venue renders in this zone. Required, not inferred.
          timezone: data.timezone,
          notes: data.notes ?? null,
        },
      }),
  })

  return Response.json({ venue: { id: venue.id, ...snapshot(venue) } }, { status: 201 })
})
