import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateDivisionSchema } from '@/lib/validation'
import { assertNameAvailable, softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertDivisionInOrg } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; divisionId: string }> }

const snapshot = (d: { name: string; description: string | null }) => ({
  name: d.name,
  description: d.description,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, divisionId } = await ctx.params
  await requirePermission(req, orgId, 'structure:read')
  const division = await assertDivisionInOrg(orgId, divisionId)

  const teams = await prisma.team.findMany({
    where: { divisionId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: {
      preferredVenue: { select: { id: true, name: true } },
      _count: { select: { memberships: { where: { deletedAt: null } } } },
    },
  })

  return Response.json({
    division: {
      id: division.id,
      seasonId: division.seasonId,
      season: { id: division.season.id, name: division.season.name },
      ...snapshot(division),
    },
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      primaryColor: t.primaryColor,
      secondaryColor: t.secondaryColor,
      preferredVenue: t.preferredVenue,
      memberCount: t._count.memberships,
    })),
  })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, divisionId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  const before = await assertDivisionInOrg(orgId, divisionId)
  const patch = await parseBody(req, updateDivisionSchema)

  if (patch.name && patch.name !== before.name) {
    await assertNameAvailable({
      delegate: prisma.division,
      where: { seasonId: before.seasonId, name: patch.name },
      label: 'That season already has a division with this name.',
      exceptId: divisionId,
    })
  }

  const division = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Division',
    entityId: divisionId,
    before: snapshot(before),
    snapshot,
    update: (tx) =>
      tx.division.update({
        where: { id: divisionId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        },
      }),
  })

  return Response.json({ division: { id: division.id, ...snapshot(division) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, divisionId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  await assertDivisionInOrg(orgId, divisionId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Division',
    entityId: divisionId,
    softDelete: (tx, deletedAt) =>
      tx.division.updateMany({ where: { id: divisionId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
