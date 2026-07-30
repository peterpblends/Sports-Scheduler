import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createDivisionSchema } from '@/lib/validation'
import { assertNameAvailable, createWithAudit } from '@/lib/crud'
import { assertSeasonInOrg } from '@/lib/scope'
import type { Division } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (d: Division) => ({
  name: d.name,
  description: d.description,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'structure:read')
  const seasonId = new URL(req.url).searchParams.get('seasonId')

  if (seasonId) await assertSeasonInOrg(orgId, seasonId)

  const divisions = await prisma.division.findMany({
    where: {
      deletedAt: null,
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
      ...(seasonId ? { seasonId } : {}),
    },
    orderBy: { name: 'asc' },
    include: {
      season: { select: { id: true, name: true } },
      _count: { select: { teams: { where: { deletedAt: null } } } },
    },
  })

  return Response.json({
    divisions: divisions.map((d) => ({
      id: d.id,
      seasonId: d.seasonId,
      season: d.season,
      ...snapshot(d),
      teamCount: d._count.teams,
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  const data = await parseBody(req, createDivisionSchema)

  await assertSeasonInOrg(orgId, data.seasonId)
  await assertNameAvailable({
    delegate: prisma.division,
    where: { seasonId: data.seasonId, name: data.name },
    label: 'That season already has a division with this name.',
  })

  const division = await createWithAudit({
    orgId,
    actor,
    entityType: 'Division',
    id: (d) => d.id,
    snapshot,
    create: (tx) =>
      tx.division.create({
        data: {
          seasonId: data.seasonId,
          name: data.name,
          description: data.description ?? null,
        },
      }),
    meta: { seasonId: data.seasonId },
  })

  return Response.json(
    { division: { id: division.id, seasonId: division.seasonId, ...snapshot(division) } },
    { status: 201 },
  )
})
