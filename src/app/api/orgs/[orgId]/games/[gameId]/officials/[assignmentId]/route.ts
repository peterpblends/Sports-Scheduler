import { forbidden, handler, notFound, parseBody, requirePermission } from '@/lib/http'
import { updateGameOfficialSchema } from '@/lib/validation'
import { softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertGameOfficialInOrg, requireAssignmentRespond } from '@/lib/scope'
import { can } from '@/lib/authz'
import type { GameOfficial } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; gameId: string; assignmentId: string }> }

const snapshot = (o: GameOfficial) => ({
  position: o.position,
  status: o.status,
  payRateCentsOverride: o.payRateCentsOverride,
  respondedAt: o.respondedAt?.toISOString() ?? null,
})

/**
 * Accept or decline an assignment, or adjust its pay rate.
 *
 * A referee may set the status of their own assignment and nothing else; an
 * assigner may change either field on anyone's. `requireAssignmentRespond`
 * decides which of the two the caller is.
 */
export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId, assignmentId } = await ctx.params
  const { actor, role, scoped } = await requireAssignmentRespond(req, orgId, assignmentId)
  const before = await assertGameOfficialInOrg(orgId, assignmentId)

  // The game in the URL must be the assignment's own game.
  if (before.gameId !== gameId) throw notFound('Assignment not found.')

  const patch = await parseBody(req, updateGameOfficialSchema)

  // Pay is an assigner's decision, never the recipient's.
  if (patch.payRateCentsOverride !== undefined && !can(role, 'official:assign')) {
    throw forbidden('You cannot change the pay rate on an assignment.')
  }

  const statusChanged = patch.status !== undefined && patch.status !== before.status

  const assignment = await updateWithAudit({
    orgId,
    actor,
    entityType: 'GameOfficial',
    entityId: assignmentId,
    action: statusChanged ? `official.${patch.status}` : 'official.updated',
    before: snapshot(before),
    snapshot,
    meta: { gameId, refereeId: before.refereeId, viaOwnScope: scoped },
    update: (tx) =>
      tx.gameOfficial.update({
        where: { id: assignmentId },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.payRateCentsOverride !== undefined
            ? { payRateCentsOverride: patch.payRateCentsOverride ?? null }
            : {}),
          ...(statusChanged ? { respondedAt: new Date() } : {}),
        },
      }),
  })

  return Response.json({ assignment: { id: assignment.id, ...snapshot(assignment) } })
})

/** Unassigning is an assigner action. A referee declines instead. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId, assignmentId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'official:assign')
  const before = await assertGameOfficialInOrg(orgId, assignmentId)
  if (before.gameId !== gameId) throw notFound('Assignment not found.')

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'GameOfficial',
    entityId: assignmentId,
    action: 'official.unassigned',
    meta: { gameId, refereeId: before.refereeId, position: before.position },
    softDelete: (tx, deletedAt) =>
      tx.gameOfficial.updateMany({
        where: { id: assignmentId, gameId, deletedAt: null },
        data: { deletedAt },
      }),
  })

  return Response.json({ ok: true })
})
