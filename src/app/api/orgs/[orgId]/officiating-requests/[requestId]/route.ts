import { prisma } from '@/lib/prisma'
import { HttpError, badRequest, conflict, handler, parseBody, requirePermission } from '@/lib/http'
import { decideOfficiatingRequestSchema } from '@/lib/validation'
import { recordAudit } from '@/lib/audit'
import { softDeleteWithAudit } from '@/lib/crud'
import {
  assertOfficiatingRequestInOrg,
  requireOfficiatingRequestWithdraw,
} from '@/lib/scope'
import { detectOfficialConflicts } from '@/lib/conflicts'
import { openPositionsFor } from '@/lib/officiating'
import { notifyOfficiatingDecided } from '@/lib/notify'
import { diffRecords } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string; requestId: string }> }

/**
 * Approve or reject a referee's request to officiate.
 *
 * Approving is an assignment, so it goes through the same gate as any other: the
 * hard rules are re-checked *now* rather than trusted from when the request was
 * made, because the crew, the referee's other games and the kickoff time can all
 * have moved in between. A violation is refused unless an override reason is given,
 * which matches the assignment board's behaviour and lands in the audit trail.
 *
 * The status change and the created GameOfficial are one transaction. A request
 * marked approved with no assignment behind it would be a lie the referee acts on.
 */
export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, requestId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'official:request:review')
  const request = await assertOfficiatingRequestInOrg(orgId, requestId)
  const data = await parseBody(req, decideOfficiatingRequestSchema)

  if (request.status !== 'pending') {
    throw conflict(`That request was already ${request.status}.`)
  }

  const before = {
    status: request.status,
    decisionNote: request.decisionNote,
    decidedAt: request.decidedAt?.toISOString() ?? null,
  }

  if (data.decision === 'rejected') {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.officiatingRequest.update({
        where: { id: requestId },
        data: {
          status: 'rejected',
          decisionNote: data.decisionNote ?? null,
          decidedById: actor.userId,
          decidedAt: new Date(),
        },
      })
      await recordAudit(
        {
          orgId,
          actorId: actor.userId,
          actorLabel: actor.email,
          entityType: 'OfficiatingRequest',
          entityId: requestId,
          action: 'officiating_request.rejected',
          diff: diffRecords(before, {
            status: row.status,
            decisionNote: row.decisionNote,
            decidedAt: row.decidedAt?.toISOString() ?? null,
          }),
          meta: {
            gameId: request.gameId,
            refereeId: request.refereeId,
            position: request.position,
          },
        },
        tx,
      )
      return row
    })

    const notified = await notifyOfficiatingDecided({
      orgId,
      gameId: request.gameId,
      requestId,
      refereeId: request.refereeId,
      decision: 'rejected',
      position: request.position,
      decisionNote: data.decisionNote ?? null,
      actorLabel: actor.email,
    })

    return Response.json({ request: { id: updated.id, status: updated.status }, notified })
  }

  // --- approval

  if (request.game.startTime.getTime() <= Date.now()) {
    throw badRequest('That game has already started.')
  }

  const officials = await prisma.gameOfficial.findMany({
    where: { gameId: request.gameId, deletedAt: null },
    select: { refereeId: true, position: true, status: true },
  })

  if (officials.some((official) => official.refereeId === request.refereeId)) {
    throw conflict('That official is already on the crew for this game.')
  }
  // Someone else may have taken the position while the request sat waiting.
  if (!openPositionsFor(officials).includes(request.position)) {
    throw conflict(
      `That game already has a ${request.position}. Reject this request, or unassign the current official first.`,
    )
  }

  const conflicts = await detectOfficialConflicts(orgId, request.gameId, request.refereeId)
  if (conflicts.length > 0 && !data.overrideReason) {
    throw new HttpError(409, 'That official cannot take this game.', { conflicts })
  }

  const result = await prisma.$transaction(async (tx) => {
    const assignment = await tx.gameOfficial.create({
      data: {
        gameId: request.gameId,
        refereeId: request.refereeId,
        position: request.position,
        // Approving a request the referee themselves asked for means their consent
        // is already on the record, so it starts accepted rather than pending. A
        // pending status here would ask them to agree to something they proposed.
        status: 'accepted',
        respondedAt: new Date(),
      },
    })

    const row = await tx.officiatingRequest.update({
      where: { id: requestId },
      data: {
        status: 'approved',
        decisionNote: data.decisionNote ?? null,
        decidedById: actor.userId,
        decidedAt: new Date(),
      },
    })

    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'OfficiatingRequest',
        entityId: requestId,
        action: 'officiating_request.approved',
        diff: diffRecords(before, {
          status: row.status,
          decisionNote: row.decisionNote,
          decidedAt: row.decidedAt?.toISOString() ?? null,
        }),
        meta: {
          gameId: request.gameId,
          refereeId: request.refereeId,
          position: request.position,
          assignmentId: assignment.id,
          ...(conflicts.length > 0
            ? { overrideReason: data.overrideReason, overriddenConflicts: conflicts }
            : {}),
        },
      },
      tx,
    )

    // The assignment gets its own history too, so the crew's story is complete
    // when read from the game rather than only from the request.
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'GameOfficial',
        entityId: assignment.id,
        action: 'official.assigned',
        diff: {
          official: { before: null, after: request.referee.person.name },
          position: { before: null, after: request.position },
          status: { before: null, after: 'accepted' },
        },
        meta: {
          via: 'request',
          gameId: request.gameId,
          refereeId: request.refereeId,
          requestId,
        },
      },
      tx,
    )

    return { assignment, row }
  })

  const notified = await notifyOfficiatingDecided({
    orgId,
    gameId: request.gameId,
    requestId,
    refereeId: request.refereeId,
    decision: 'approved',
    position: request.position,
    decisionNote: data.decisionNote ?? null,
    actorLabel: actor.email,
  })

  return Response.json({
    request: { id: result.row.id, status: result.row.status },
    assignment: { id: result.assignment.id, position: result.assignment.position },
    conflicts,
    notified,
  })
})

/**
 * Withdraw a request.
 *
 * A referee retracting their own offer and an assigner clearing it off the board
 * are the same state change but not the same event, so the audit action records
 * which it was. Soft-deleted rather than removed, like everything else.
 */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, requestId } = await ctx.params
  const { actor, scoped } = await requireOfficiatingRequestWithdraw(req, orgId, requestId)
  const request = await assertOfficiatingRequestInOrg(orgId, requestId)

  if (request.status === 'approved') {
    throw conflict(
      'That request was already approved. Ask an assigner to take you off the game instead.',
    )
  }

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'OfficiatingRequest',
    entityId: requestId,
    action: scoped ? 'officiating_request.withdrawn' : 'officiating_request.retracted',
    meta: {
      gameId: request.gameId,
      refereeId: request.refereeId,
      position: request.position,
      statusAtWithdrawal: request.status,
    },
    softDelete: (tx, deletedAt) =>
      tx.officiatingRequest.updateMany({
        where: { id: requestId, deletedAt: null },
        data: { deletedAt, status: 'withdrawn' },
      }),
  })

  return Response.json({ ok: true })
})
