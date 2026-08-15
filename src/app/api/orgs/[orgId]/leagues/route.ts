import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createLeagueSchema } from '@/lib/validation'
import { assertNameAvailable, createWithAudit } from '@/lib/crud'
import type { League } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (l: League) => ({
  name: l.name,
  sport: l.sport,
  description: l.description,
  logoUrl: l.logoUrl,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'structure:read')

  const leagues = await prisma.league.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { seasons: { where: { deletedAt: null } } } },
    },
  })

  return Response.json({
    leagues: leagues.map((l) => ({
      id: l.id,
      ...snapshot(l),
      seasonCount: l._count.seasons,
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  const data = await parseBody(req, createLeagueSchema)

  await assertNameAvailable({
    delegate: prisma.league,
    where: { orgId, name: data.name },
    label: 'A league with that name already exists.',
  })

  const league = await createWithAudit({
    orgId,
    actor,
    entityType: 'League',
    id: (l) => l.id,
    snapshot,
    create: (tx) =>
      tx.league.create({
        data: {
          orgId,
          name: data.name,
          sport: data.sport,
          description: data.description ?? null,
          logoUrl: data.logoUrl ?? null,
        },
      }),
  })

  return Response.json({ league: { id: league.id, ...snapshot(league) } }, { status: 201 })
})
