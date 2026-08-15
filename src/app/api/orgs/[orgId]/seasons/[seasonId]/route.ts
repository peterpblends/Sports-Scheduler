import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateSeasonSchema } from '@/lib/validation'
import { assertNameAvailable, softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertSeasonInOrg } from '@/lib/scope'
import { formatCalendarDate, parseCalendarDate } from '@/lib/time'
import { conflict } from '@/lib/http'
import type { Season } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

const snapshot = (s: Season) => ({
  name: s.name,
  startDate: formatCalendarDate(s.startDate),
  endDate: formatCalendarDate(s.endDate),
  status: s.status,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  await requirePermission(req, orgId, 'structure:read')
  const season = await assertSeasonInOrg(orgId, seasonId)

  const divisions = await prisma.division.findMany({
    where: { seasonId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: { _count: { select: { teams: { where: { deletedAt: null } } } } },
  })

  return Response.json({
    season: {
      id: season.id,
      leagueId: season.leagueId,
      league: { id: season.league.id, name: season.league.name, sport: season.league.sport },
      ...snapshot(season),
    },
    divisions: divisions.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      teamCount: d._count.teams,
    })),
  })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  const before = await assertSeasonInOrg(orgId, seasonId)
  const patch = await parseBody(req, updateSeasonSchema)

  const startDate = patch.startDate ? parseCalendarDate(patch.startDate) : before.startDate
  const endDate = patch.endDate ? parseCalendarDate(patch.endDate) : before.endDate
  if (endDate.getTime() < startDate.getTime()) {
    throw conflict('The end date cannot be before the start date.')
  }

  if (patch.name && patch.name !== before.name) {
    await assertNameAvailable({
      delegate: prisma.season,
      where: { leagueId: before.leagueId, name: patch.name },
      label: 'That league already has a season with this name.',
      exceptId: seasonId,
    })
  }

  const season = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Season',
    entityId: seasonId,
    before: snapshot(before),
    snapshot,
    update: (tx) =>
      tx.season.update({
        where: { id: seasonId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.startDate !== undefined ? { startDate } : {}),
          ...(patch.endDate !== undefined ? { endDate } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        },
      }),
  })

  return Response.json({ season: { id: season.id, ...snapshot(season) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  await assertSeasonInOrg(orgId, seasonId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Season',
    entityId: seasonId,
    softDelete: (tx, deletedAt) =>
      tx.season.updateMany({ where: { id: seasonId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
