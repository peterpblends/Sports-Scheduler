import { prisma } from '@/lib/prisma'
import { HttpError, conflict, handler, parseBody, requirePermission } from '@/lib/http'
import { createGameOfficialSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertGameInOrg, assertRefereeInOrg } from '@/lib/scope'
import { detectOfficialConflicts } from '@/lib/conflicts'
import { notifyAssignmentChanged } from '@/lib/notify'
import type { GameOfficial } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; gameId: string }> }

const snapshot = (o: GameOfficial) => ({
  gameId: o.gameId,
  refereeId: o.refereeId,
  position: o.position,
  status: o.status,
  payRateCentsOverride: o.payRateCentsOverride,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  await requirePermission(req, orgId, 'official:read')
  await assertGameInOrg(orgId, gameId)

  const officials = await prisma.gameOfficial.findMany({
    where: { gameId, deletedAt: null },
    include: { referee: { include: { person: { select: { id: true, name: true, email: true } } } } },
  })

  return Response.json({ officials })
})

/**
 * Assigns an official to a game.
 *
 * The four hard rules — availability, daily cap, overlapping assignment or too
 * little travel time, and conflict of interest — are checked first. A violation is
 * refused unless `overrideReason` is supplied, which is then logged. Conflict of
 * interest is the one an assigner should almost never override, so the reason
 * lands in the audit trail with the specific conflict attached.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'official:assign')
  await assertGameInOrg(orgId, gameId)
  const data = await parseBody(req, createGameOfficialSchema)
  await assertRefereeInOrg(orgId, data.refereeId)

  // A declined assignment does not hold its position — that is what declining means,
  // and it is how `openPositionsFor` and the database's partial unique indexes both
  // define an open slot.
  //
  // This check previously counted any non-deleted row, including declined ones, which
  // put it at odds with the rest of the application: the assignment board lists a
  // game with a decline on it as needing an official, and this endpoint then refused
  // to supply one. An assigner following the board's own advice hit
  // "That game already has a center" and had no way forward. The request-approval
  // path, which used the shared rule, would happily fill the same slot.
  const held = { deletedAt: null, status: { not: 'declined' } } as const

  const existingPosition = await prisma.gameOfficial.findFirst({
    where: { gameId, position: data.position, ...held },
  })
  if (existingPosition) throw conflict(`That game already has a ${data.position}.`)

  const alreadyOnGame = await prisma.gameOfficial.findFirst({
    where: { gameId, refereeId: data.refereeId, ...held },
  })
  if (alreadyOnGame) throw conflict('That official is already assigned to this game.')

  const conflicts = await detectOfficialConflicts(orgId, gameId, data.refereeId)
  if (conflicts.length > 0 && !data.overrideReason) {
    throw new HttpError(409, 'That official cannot take this game.', { conflicts })
  }

  const assignment = await createWithAudit({
    orgId,
    actor,
    entityType: 'GameOfficial',
    action: 'official.assigned',
    id: (o) => o.id,
    snapshot,
    meta: {
      gameId,
      refereeId: data.refereeId,
      ...(conflicts.length > 0
        ? { overrideReason: data.overrideReason, overriddenConflicts: conflicts }
        : {}),
    },
    create: (tx) =>
      tx.gameOfficial.create({
        data: {
          gameId,
          refereeId: data.refereeId,
          position: data.position,
          payRateCentsOverride: data.payRateCentsOverride ?? null,
        },
      }),
  })

  // After the write, so a mail failure cannot undo the assignment.
  const notified = await notifyAssignmentChanged({
    orgId,
    gameId,
    refereeId: data.refereeId,
    change: 'assigned',
    position: data.position,
    actorLabel: actor.email,
  })

  return Response.json(
    { assignment: { id: assignment.id, ...snapshot(assignment) }, conflicts, notified },
    { status: 201 },
  )
})
