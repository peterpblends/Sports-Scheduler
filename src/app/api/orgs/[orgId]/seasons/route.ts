import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createSeasonSchema } from '@/lib/validation'
import { assertNameAvailable, createWithAudit } from '@/lib/crud'
import { assertLeagueInOrg } from '@/lib/scope'
import { formatCalendarDate, parseCalendarDate } from '@/lib/time'
import type { Season } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (s: Season) => ({
  name: s.name,
  startDate: formatCalendarDate(s.startDate),
  endDate: formatCalendarDate(s.endDate),
  status: s.status,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'structure:read')
  const leagueId = new URL(req.url).searchParams.get('leagueId')

  // The league filter is still verified against the org, so it cannot be used to
  // read another tenant's seasons.
  if (leagueId) await assertLeagueInOrg(orgId, leagueId)

  const seasons = await prisma.season.findMany({
    where: {
      deletedAt: null,
      league: { orgId, deletedAt: null },
      ...(leagueId ? { leagueId } : {}),
    },
    orderBy: [{ startDate: 'desc' }, { name: 'asc' }],
    include: {
      league: { select: { id: true, name: true, sport: true } },
      _count: { select: { divisions: { where: { deletedAt: null } } } },
    },
  })

  return Response.json({
    seasons: seasons.map((s) => ({
      id: s.id,
      leagueId: s.leagueId,
      league: s.league,
      ...snapshot(s),
      divisionCount: s._count.divisions,
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  const data = await parseBody(req, createSeasonSchema)

  await assertLeagueInOrg(orgId, data.leagueId)
  await assertNameAvailable({
    delegate: prisma.season,
    where: { leagueId: data.leagueId, name: data.name },
    label: 'That league already has a season with this name.',
  })

  const season = await createWithAudit({
    orgId,
    actor,
    entityType: 'Season',
    id: (s) => s.id,
    snapshot,
    create: (tx) =>
      tx.season.create({
        data: {
          leagueId: data.leagueId,
          name: data.name,
          startDate: parseCalendarDate(data.startDate),
          endDate: parseCalendarDate(data.endDate),
          status: data.status,
        },
      }),
    meta: { leagueId: data.leagueId },
  })

  return Response.json({ season: { id: season.id, leagueId: season.leagueId, ...snapshot(season) } }, { status: 201 })
})
