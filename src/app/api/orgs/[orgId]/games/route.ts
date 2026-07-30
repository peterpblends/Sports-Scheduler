import { prisma } from '@/lib/prisma'
import { HttpError, badRequest, handler, parseBody, requirePermission } from '@/lib/http'
import { createGameSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertDivisionInOrg, assertFieldInOrg, assertSeasonInOrg, assertTeamInOrg } from '@/lib/scope'
import { detectGameConflicts } from '@/lib/conflicts'
import { formatInstantInZone } from '@/lib/time'
import type { Game } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (g: Game) => ({
  divisionId: g.divisionId,
  homeTeamId: g.homeTeamId,
  awayTeamId: g.awayTeamId,
  fieldId: g.fieldId,
  startTime: g.startTime.toISOString(),
  durationMinutes: g.durationMinutes,
  status: g.status,
  roundNumber: g.roundNumber,
  homeScore: g.homeScore,
  awayScore: g.awayScore,
  notes: g.notes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  // Phase 4 splits this into draft vs published reads; for now any member who can
  // read a schedule can list games.
  await requirePermission(req, orgId, 'schedule:read:published')

  const params = new URL(req.url).searchParams
  const seasonId = params.get('seasonId')
  const divisionId = params.get('divisionId')
  const teamId = params.get('teamId')
  const from = params.get('from')
  const to = params.get('to')

  if (seasonId) await assertSeasonInOrg(orgId, seasonId)
  if (divisionId) await assertDivisionInOrg(orgId, divisionId)
  if (teamId) await assertTeamInOrg(orgId, teamId)

  const games = await prisma.game.findMany({
    where: {
      deletedAt: null,
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
      ...(seasonId ? { seasonId } : {}),
      ...(divisionId ? { divisionId } : {}),
      ...(teamId ? { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] } : {}),
      ...(from || to
        ? {
            startTime: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    orderBy: { startTime: 'asc' },
    take: 2000,
    include: {
      homeTeam: { select: { id: true, name: true } },
      awayTeam: { select: { id: true, name: true } },
      division: { select: { id: true, name: true } },
      field: { include: { venue: { select: { id: true, name: true, timezone: true } } } },
      officials: {
        where: { deletedAt: null },
        include: { referee: { include: { person: { select: { id: true, name: true } } } } },
      },
    },
  })

  return Response.json({
    games: games.map((g) => ({
      id: g.id,
      seasonId: g.seasonId,
      ...snapshot(g),
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      division: g.division,
      field: g.field ? { id: g.field.id, name: g.field.name, venue: g.field.venue } : null,
      // Rendered in the venue's zone, never the server's or the viewer's.
      localStartTime: g.field
        ? formatInstantInZone(g.startTime, g.field.venue.timezone)
        : null,
      officials: g.officials.map((o) => ({
        id: o.id,
        position: o.position,
        status: o.status,
        referee: { id: o.refereeId, name: o.referee.person.name },
      })),
    })),
  })
})

/**
 * Creates a one-off game outside the generated schedule.
 *
 * Hard constraints are checked before the write. A violation is a 409 carrying the
 * full conflict list, unless the caller supplies `overrideReason` — the reason is
 * then required, recorded on the audit event, and the game is created anyway. That
 * is the "warn, but let an admin override with a logged reason" rule.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:edit')
  const body = await parseBody(req, createGameSchema)

  const division = await assertDivisionInOrg(orgId, body.divisionId)
  const home = await assertTeamInOrg(orgId, body.homeTeamId)
  const away = await assertTeamInOrg(orgId, body.awayTeamId)
  if (body.fieldId) await assertFieldInOrg(orgId, body.fieldId)

  if (home.id === away.id) throw badRequest('A team cannot play itself.')
  if (home.divisionId !== division.id || away.divisionId !== division.id) {
    // Cross-division play is a phase 3 scheduling option, configured there rather
    // than assembled ad hoc here.
    throw badRequest('Both teams must belong to the division for a manually added game.')
  }

  const startTime = new Date(body.startTime)
  const { overrideReason } = body

  const conflicts = await detectGameConflicts(orgId, {
    seasonId: division.seasonId,
    divisionId: division.id,
    homeTeamId: home.id,
    awayTeamId: away.id,
    fieldId: body.fieldId ?? null,
    startTime,
    durationMinutes: body.durationMinutes,
  })

  if (conflicts.length > 0 && !overrideReason) {
    throw new HttpError(409, 'That placement breaks a hard constraint.', { conflicts })
  }

  const game = await createWithAudit({
    orgId,
    actor,
    entityType: 'Game',
    action: 'game.created',
    id: (g) => g.id,
    snapshot,
    meta: {
      manual: true,
      ...(conflicts.length > 0 ? { overrideReason, overriddenConflicts: conflicts } : {}),
    },
    create: (tx) =>
      tx.game.create({
        data: {
          seasonId: division.seasonId,
          divisionId: division.id,
          homeTeamId: home.id,
          awayTeamId: away.id,
          fieldId: body.fieldId ?? null,
          startTime,
          durationMinutes: body.durationMinutes,
          status: body.status,
          roundNumber: body.roundNumber ?? null,
          notes: body.notes ?? null,
        },
      }),
  })

  return Response.json(
    { game: { id: game.id, seasonId: game.seasonId, ...snapshot(game) }, conflicts },
    { status: 201 },
  )
})
