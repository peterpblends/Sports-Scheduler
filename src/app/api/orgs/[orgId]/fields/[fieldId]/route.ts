import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateFieldSchema } from '@/lib/validation'
import { assertNameAvailable, softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertFieldInOrg } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; fieldId: string }> }

const snapshot = (f: { name: string; notes: string | null }) => ({ name: f.name, notes: f.notes })

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, fieldId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  const before = await assertFieldInOrg(orgId, fieldId)
  const patch = await parseBody(req, updateFieldSchema)

  if (patch.name && patch.name !== before.name) {
    await assertNameAvailable({
      delegate: prisma.field,
      where: { venueId: before.venueId, name: patch.name },
      label: 'That venue already has a field with this name.',
      exceptId: fieldId,
    })
  }

  const field = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Field',
    entityId: fieldId,
    before: snapshot(before),
    snapshot,
    update: (tx) =>
      tx.field.update({
        where: { id: fieldId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
        },
      }),
  })

  return Response.json({ field: { id: field.id, ...snapshot(field) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, fieldId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  await assertFieldInOrg(orgId, fieldId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Field',
    entityId: fieldId,
    softDelete: (tx, deletedAt) =>
      tx.field.updateMany({ where: { id: fieldId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
