import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateLeagueSchema } from '@/lib/validation'
import { assertNameAvailable, softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertLeagueInOrg } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; leagueId: string }> }

const snapshot = (l: {
  name: string
  sport: string
  description: string | null
  logoUrl: string | null
}) => ({
  name: l.name,
  sport: l.sport,
  description: l.description,
  logoUrl: l.logoUrl,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, leagueId } = await ctx.params
  await requirePermission(req, orgId, 'structure:read')
  const league = await assertLeagueInOrg(orgId, leagueId)

  const seasons = await prisma.season.findMany({
    where: { leagueId, deletedAt: null },
    orderBy: { startDate: 'desc' },
  })

  return Response.json({ league: { id: league.id, ...snapshot(league) }, seasons })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, leagueId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  const before = await assertLeagueInOrg(orgId, leagueId)
  const patch = await parseBody(req, updateLeagueSchema)

  if (patch.name && patch.name !== before.name) {
    await assertNameAvailable({
      delegate: prisma.league,
      where: { orgId, name: patch.name },
      label: 'A league with that name already exists.',
      exceptId: leagueId,
    })
  }

  const league = await updateWithAudit({
    orgId,
    actor,
    entityType: 'League',
    entityId: leagueId,
    before: snapshot(before),
    snapshot,
    update: (tx) =>
      tx.league.update({
        where: { id: leagueId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sport !== undefined ? { sport: patch.sport } : {}),
          ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
          ...(patch.logoUrl !== undefined ? { logoUrl: patch.logoUrl ?? null } : {}),
        },
      }),
  })

  return Response.json({ league: { id: league.id, ...snapshot(league) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, leagueId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'structure:write')
  await assertLeagueInOrg(orgId, leagueId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'League',
    entityId: leagueId,
    softDelete: (tx, deletedAt) =>
      tx.league.updateMany({ where: { id: leagueId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
