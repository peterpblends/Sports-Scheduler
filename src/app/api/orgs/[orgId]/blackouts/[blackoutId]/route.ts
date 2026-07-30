import { handler, requirePermission } from '@/lib/http'
import { softDeleteWithAudit } from '@/lib/crud'
import { assertBlackoutInOrg } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; blackoutId: string }> }

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, blackoutId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  const blackout = await assertBlackoutInOrg(orgId, blackoutId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'BlackoutDate',
    entityId: blackoutId,
    meta: { scope: blackout.scope, reason: blackout.reason },
    softDelete: (tx, deletedAt) =>
      tx.blackoutDate.updateMany({
        where: { id: blackoutId, orgId, deletedAt: null },
        data: { deletedAt },
      }),
  })

  return Response.json({ ok: true })
})
