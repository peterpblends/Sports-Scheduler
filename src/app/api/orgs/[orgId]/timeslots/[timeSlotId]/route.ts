import { handler, requirePermission } from '@/lib/http'
import { softDeleteWithAudit } from '@/lib/crud'
import { assertTimeSlotInOrg } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; timeSlotId: string }> }

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, timeSlotId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  const slot = await assertTimeSlotInOrg(orgId, timeSlotId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'TimeSlot',
    entityId: timeSlotId,
    meta: { fieldId: slot.fieldId },
    softDelete: (tx, deletedAt) =>
      tx.timeSlot.updateMany({ where: { id: timeSlotId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
