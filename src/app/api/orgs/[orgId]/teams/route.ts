import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createTeamSchema } from '@/lib/validation'
import { assertNameAvailable, createWithAudit } from '@/lib/crud'
import { assertDivisionInOrg, assertVenueInOrg, staffTeamIds } from '@/lib/scope'
import { can } from '@/lib/authz'
import type { Team } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (t: Team) => ({
  name: t.name,
  primaryColor: t.primaryColor,
  secondaryColor: t.secondaryColor,
  logoUrl: t.logoUrl,
  preferredVenueId: t.preferredVenueId,
  contactName: t.contactName,
  contactEmail: t.contactEmail,
  contactPhone: t.contactPhone,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor, role } = await requirePermission(req, orgId, 'roster:read')
  const divisionId = new URL(req.url).searchParams.get('divisionId')

  if (divisionId) await assertDivisionInOrg(orgId, divisionId)

  const teams = await prisma.team.findMany({
    where: {
      deletedAt: null,
      division: {
        deletedAt: null,
        season: { deletedAt: null, league: { orgId, deletedAt: null } },
      },
      ...(divisionId ? { divisionId } : {}),
    },
    orderBy: { name: 'asc' },
    include: {
      division: { select: { id: true, name: true, seasonId: true } },
      preferredVenue: { select: { id: true, name: true } },
      _count: { select: { memberships: { where: { deletedAt: null } } } },
    },
  })

  // A coach sees every team in the roster list (they need opponents' names), but
  // the response marks which ones they may actually write to.
  const writable = can(role, 'roster:write')
    ? null
    : new Set(can(role, 'roster:write:own') ? await staffTeamIds(actor.userId, orgId) : [])

  return Response.json({
    teams: teams.map((t) => ({
      id: t.id,
      divisionId: t.divisionId,
      division: t.division,
      ...snapshot(t),
      preferredVenue: t.preferredVenue,
      memberCount: t._count.memberships,
      canEdit: writable === null ? true : writable.has(t.id),
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  // Creating a team is org-wide roster control; a coach cannot invent teams.
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const data = await parseBody(req, createTeamSchema)

  await assertDivisionInOrg(orgId, data.divisionId)
  if (data.preferredVenueId) await assertVenueInOrg(orgId, data.preferredVenueId)

  await assertNameAvailable({
    delegate: prisma.team,
    where: { divisionId: data.divisionId, name: data.name },
    label: 'That division already has a team with this name.',
  })

  const team = await createWithAudit({
    orgId,
    actor,
    entityType: 'Team',
    id: (t) => t.id,
    snapshot,
    create: (tx) =>
      tx.team.create({
        data: {
          divisionId: data.divisionId,
          name: data.name,
          primaryColor: data.primaryColor ?? null,
          secondaryColor: data.secondaryColor ?? null,
          logoUrl: data.logoUrl ?? null,
          preferredVenueId: data.preferredVenueId ?? null,
          contactName: data.contactName ?? null,
          contactEmail: data.contactEmail ?? null,
          contactPhone: data.contactPhone ?? null,
        },
      }),
    meta: { divisionId: data.divisionId },
  })

  return Response.json({ team: { id: team.id, divisionId: team.divisionId, ...snapshot(team) } }, { status: 201 })
})
