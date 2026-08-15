import { prisma } from '@/lib/prisma'
import { HttpError, badRequest, conflict, handler, parseBody, requirePermission } from '@/lib/http'
import { createOfficiatingRequestSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertGameInOrg, requireOwnRefereeRequest } from '@/lib/scope'
import { can } from '@/lib/authz'
import { detectOfficialConflicts } from '@/lib/conflicts'
import { openPositionsFor } from '@/lib/officiating'
import { notifyOfficiatingRequested } from '@/lib/notify'
import type { OfficiatingRequest } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; gameId: string }> }

const snapshot = (r: OfficiatingRequest) => ({
  gameId: r.gameId,
  refereeId: r.refereeId,
  position: r.position,
  status: r.status,
  note: r.note,
})

/** Requests on one game. Reviewers see all of them; a referee sees their own. */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  const { actor, role } = await requirePermission(req, orgId, 'org:read')
  await assertGameInOrg(orgId, gameId)

  const reviewer = can(role, 'official:request:review')
  const requests = await prisma.officiatingRequest.findMany({
    where: {
      gameId,
      deletedAt: null,
      // A referee is shown only their own row, so the endpoint cannot be used to
      // find out who else is competing for a game.
      ...(reviewer ? {} : { referee: { person: { userId: actor.userId, orgId } } }),
    },
    orderBy: { createdAt: 'asc' },
    include: { referee: { include: { person: { select: { id: true, name: true } } } } },
  })

  return Response.json({ requests })
})

/**
 * A referee asks to officiate this game.
 *
 * Which referee is decided by the session, not the body — see
 * `requireOwnRefereeRequest`. Everything else here is about refusing a request
 * that could not be honoured anyway:
 *
 *  * the game must be in the future, since volunteering for a finished match is
 *    always a mistake rather than an intention;
 *  * the position must actually be open;
 *  * they must not already be on the crew or have a live request; and
 *  * the four hard rules must pass.
 *
 * That last one is refused outright rather than offered with an override. An
 * override is an assigner's judgement call to make — a referee cannot wave away
 * their own conflict of interest, which would defeat the point of having the rule.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  const { actor, referee } = await requireOwnRefereeRequest(req, orgId)
  const game = await assertGameInOrg(orgId, gameId)
  const data = await parseBody(req, createOfficiatingRequestSchema)

  if (game.startTime.getTime() <= Date.now()) {
    throw badRequest('That game has already started. Ask an assigner if you need to be added.')
  }
  if (game.status === 'cancelled') {
    throw badRequest('That game is cancelled.')
  }

  const [officials, existingRequests] = await Promise.all([
    prisma.gameOfficial.findMany({
      where: { gameId, deletedAt: null },
      select: { refereeId: true, position: true, status: true },
    }),
    prisma.officiatingRequest.findMany({
      where: { gameId, refereeId: referee.id, deletedAt: null, status: 'pending' },
      select: { id: true, position: true },
    }),
  ])

  if (officials.some((official) => official.refereeId === referee.id)) {
    throw conflict('You are already on the crew for that game.')
  }
  if (existingRequests.length > 0) {
    throw conflict('You already have a request pending on that game.')
  }

  // Reuse the same open-position rule the board displays, so a referee is never
  // offered a button that the endpoint then refuses.
  if (!openPositionsFor(officials).includes(data.position)) {
    throw conflict(`That game already has a ${data.position}.`)
  }

  const conflicts = await detectOfficialConflicts(orgId, gameId, referee.id)
  if (conflicts.length > 0) {
    throw new HttpError(
      409,
      'You cannot take that game.',
      // The reasons are returned so the referee can act on them — a blackout they
      // forgot to clear is fixable by them; a conflict of interest is not.
      { conflicts },
    )
  }

  const request = await createWithAudit({
    orgId,
    actor,
    entityType: 'OfficiatingRequest',
    action: 'officiating_request.created',
    id: (r) => r.id,
    snapshot,
    meta: { gameId, refereeId: referee.id, position: data.position },
    create: (tx) =>
      tx.officiatingRequest.create({
        data: {
          gameId,
          refereeId: referee.id,
          position: data.position,
          note: data.note ?? null,
        },
      }),
  })

  // After the write, so a mail failure cannot lose the request.
  const notified = await notifyOfficiatingRequested({
    orgId,
    gameId,
    requestId: request.id,
    refereeName: referee.name,
    position: data.position,
    note: data.note ?? null,
    actorUserId: actor.userId,
    actorLabel: actor.email,
  })

  return Response.json({ request: { id: request.id, ...snapshot(request) }, notified }, { status: 201 })
})
