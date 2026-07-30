import { prisma } from '@/lib/prisma'
import { HttpError, handler, parseBody, requirePermission } from '@/lib/http'
import { updateGameSchema } from '@/lib/validation'
import { softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertFieldInOrg, assertGameInOrg } from '@/lib/scope'
import { detectGameConflicts } from '@/lib/conflicts'
import { formatInstantInZone } from '@/lib/time'
import type { Game } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; gameId: string }> }

const snapshot = (g: Game) => ({
  fieldId: g.fieldId,
  startTime: g.startTime.toISOString(),
  durationMinutes: g.durationMinutes,
  status: g.status,
  homeScore: g.homeScore,
  awayScore: g.awayScore,
  roundNumber: g.roundNumber,
  notes: g.notes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  await requirePermission(req, orgId, 'schedule:read:published')
  const game = await assertGameInOrg(orgId, gameId)

  const [officials, history] = await Promise.all([
    prisma.gameOfficial.findMany({
      where: { gameId, deletedAt: null },
      include: { referee: { include: { person: { select: { id: true, name: true } } } } },
    }),
    // The per-entity history panel the spec asks for: who changed this game, when.
    prisma.auditEvent.findMany({
      where: { entityType: 'Game', entityId: gameId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ])

  const tz = game.field?.venue.timezone ?? null

  return Response.json({
    game: {
      id: game.id,
      seasonId: game.seasonId,
      divisionId: game.divisionId,
      homeTeam: { id: game.homeTeam.id, name: game.homeTeam.name },
      awayTeam: { id: game.awayTeam.id, name: game.awayTeam.name },
      field: game.field
        ? { id: game.field.id, name: game.field.name, venue: game.field.venue }
        : null,
      ...snapshot(game),
      localStartTime: tz ? formatInstantInZone(game.startTime, tz) : null,
      timezone: tz,
    },
    officials: officials.map((o) => ({
      id: o.id,
      position: o.position,
      status: o.status,
      referee: { id: o.refereeId, name: o.referee.person.name },
    })),
    history,
  })
})

/**
 * Moving or editing a game. Re-runs the hard-constraint check for the new
 * placement; a violation is refused with the conflict list unless the caller
 * passes `overrideReason`, which is then recorded on the audit event.
 *
 * This is the endpoint behind phase 5's drag-and-drop: drop, get warnings,
 * confirm with a reason.
 */
export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:edit')
  const before = await assertGameInOrg(orgId, gameId)
  const patch = await parseBody(req, updateGameSchema)

  if (patch.fieldId) await assertFieldInOrg(orgId, patch.fieldId)

  const fieldId = patch.fieldId !== undefined ? (patch.fieldId ?? null) : before.fieldId
  const startTime = patch.startTime ? new Date(patch.startTime) : before.startTime
  const durationMinutes = patch.durationMinutes ?? before.durationMinutes
  const status = patch.status ?? before.status

  // Only re-check when the placement actually moves. A score entry does not need
  // to pass a double-booking check.
  const placementChanged =
    fieldId !== before.fieldId ||
    startTime.getTime() !== before.startTime.getTime() ||
    durationMinutes !== before.durationMinutes ||
    status !== before.status

  let conflicts: Awaited<ReturnType<typeof detectGameConflicts>> = []
  const stillHoldsASlot = status === 'scheduled' || status === 'confirmed' || status === 'played'

  if (placementChanged && stillHoldsASlot) {
    conflicts = await detectGameConflicts(orgId, {
      gameId,
      seasonId: before.seasonId,
      divisionId: before.divisionId,
      homeTeamId: before.homeTeamId,
      awayTeamId: before.awayTeamId,
      fieldId,
      startTime,
      durationMinutes,
    })

    if (conflicts.length > 0 && !patch.overrideReason) {
      throw new HttpError(409, 'That placement breaks a hard constraint.', { conflicts })
    }
  }

  const game = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Game',
    entityId: gameId,
    action: placementChanged ? 'game.moved' : 'game.updated',
    before: snapshot(before),
    snapshot,
    meta: conflicts.length > 0
      ? { overrideReason: patch.overrideReason, overriddenConflicts: conflicts }
      : undefined,
    update: (tx) =>
      tx.game.update({
        where: { id: gameId },
        data: {
          ...(patch.fieldId !== undefined ? { fieldId: patch.fieldId ?? null } : {}),
          ...(patch.startTime !== undefined ? { startTime } : {}),
          ...(patch.durationMinutes !== undefined ? { durationMinutes } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.homeScore !== undefined ? { homeScore: patch.homeScore ?? null } : {}),
          ...(patch.awayScore !== undefined ? { awayScore: patch.awayScore ?? null } : {}),
          ...(patch.roundNumber !== undefined ? { roundNumber: patch.roundNumber ?? null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
        },
      }),
  })

  return Response.json({ game: { id: game.id, ...snapshot(game) }, conflicts })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:edit')
  await assertGameInOrg(orgId, gameId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Game',
    entityId: gameId,
    softDelete: (tx, deletedAt) =>
      tx.game.updateMany({ where: { id: gameId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
