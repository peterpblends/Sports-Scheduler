import { handler } from '@/lib/http'
import { softDeleteWithAudit } from '@/lib/crud'
import { requireAvailabilityWrite } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; refereeId: string; availabilityId: string }> }

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, refereeId, availabilityId } = await ctx.params
  const { actor, scoped } = await requireAvailabilityWrite(req, orgId, refereeId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'RefereeAvailability',
    entityId: availabilityId,
    action: 'availability.removed',
    meta: { refereeId, viaOwnScope: scoped },
    // Scoped by refereeId too: the referee in the URL is authoritative, so a
    // referee cannot delete someone else's window by guessing its id.
    softDelete: (tx, deletedAt) =>
      tx.refereeAvailability.updateMany({
        where: { id: availabilityId, refereeId, deletedAt: null },
        data: { deletedAt },
      }),
  })

  return Response.json({ ok: true })
})
