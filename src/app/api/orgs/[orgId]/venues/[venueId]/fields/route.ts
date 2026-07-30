import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createFieldSchema } from '@/lib/validation'
import { assertNameAvailable, createWithAudit } from '@/lib/crud'
import { assertVenueInOrg } from '@/lib/scope'
import type { Field } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; venueId: string }> }

const snapshot = (f: Field) => ({ name: f.name, notes: f.notes })

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, venueId } = await ctx.params
  await requirePermission(req, orgId, 'venue:read')
  await assertVenueInOrg(orgId, venueId)

  const fields = await prisma.field.findMany({
    where: { venueId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: { timeSlots: { where: { deletedAt: null } } },
  })

  return Response.json({ fields })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, venueId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  await assertVenueInOrg(orgId, venueId)
  const data = await parseBody(req, createFieldSchema)

  await assertNameAvailable({
    delegate: prisma.field,
    where: { venueId, name: data.name },
    label: 'That venue already has a field with this name.',
  })

  const field = await createWithAudit({
    orgId,
    actor,
    entityType: 'Field',
    id: (f) => f.id,
    snapshot,
    meta: { venueId },
    create: (tx) => tx.field.create({ data: { venueId, name: data.name, notes: data.notes ?? null } }),
  })

  return Response.json({ field: { id: field.id, venueId, ...snapshot(field) } }, { status: 201 })
})
