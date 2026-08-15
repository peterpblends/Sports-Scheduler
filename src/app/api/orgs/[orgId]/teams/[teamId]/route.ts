import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updateTeamSchema } from '@/lib/validation'
import { assertNameAvailable, softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertTeamInOrg, assertVenueInOrg, requireTeamRosterWrite } from '@/lib/scope'
import type { Team } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; teamId: string }> }

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
  const { orgId, teamId } = await ctx.params
  await requirePermission(req, orgId, 'roster:read')
  const team = await assertTeamInOrg(orgId, teamId)

  const members = await prisma.teamMembership.findMany({
    where: { teamId, deletedAt: null },
    orderBy: [{ role: 'asc' }, { jerseyNumber: 'asc' }],
    include: { person: { select: { id: true, name: true, email: true, phone: true } } },
  })

  return Response.json({
    team: {
      id: team.id,
      divisionId: team.divisionId,
      division: {
        id: team.division.id,
        name: team.division.name,
        seasonId: team.division.seasonId,
        seasonName: team.division.season.name,
      },
      ...snapshot(team),
    },
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      jerseyNumber: m.jerseyNumber,
      activeFrom: m.activeFrom,
      activeTo: m.activeTo,
      person: m.person,
    })),
  })
})

/**
 * Editing a team's own details. An admin may edit any team; a coach may edit only
 * a team they are staff of — see `requireTeamRosterWrite`.
 */
export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId } = await ctx.params
  const { actor, scoped } = await requireTeamRosterWrite(req, orgId, teamId)
  const before = await assertTeamInOrg(orgId, teamId)
  const patch = await parseBody(req, updateTeamSchema)

  if (patch.preferredVenueId) await assertVenueInOrg(orgId, patch.preferredVenueId)

  if (patch.name && patch.name !== before.name) {
    await assertNameAvailable({
      delegate: prisma.team,
      where: { divisionId: before.divisionId, name: patch.name },
      label: 'That division already has a team with this name.',
      exceptId: teamId,
    })
  }

  const team = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Team',
    entityId: teamId,
    before: snapshot(before),
    snapshot,
    meta: { viaOwnTeamScope: scoped },
    update: (tx) =>
      tx.team.update({
        where: { id: teamId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.primaryColor !== undefined ? { primaryColor: patch.primaryColor ?? null } : {}),
          ...(patch.secondaryColor !== undefined
            ? { secondaryColor: patch.secondaryColor ?? null }
            : {}),
          ...(patch.logoUrl !== undefined ? { logoUrl: patch.logoUrl ?? null } : {}),
          ...(patch.preferredVenueId !== undefined
            ? { preferredVenueId: patch.preferredVenueId ?? null }
            : {}),
          ...(patch.contactName !== undefined ? { contactName: patch.contactName ?? null } : {}),
          ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail ?? null } : {}),
          ...(patch.contactPhone !== undefined ? { contactPhone: patch.contactPhone ?? null } : {}),
        },
      }),
  })

  return Response.json({ team: { id: team.id, ...snapshot(team) } })
})

/** Removing a team entirely is org-wide roster control, never a coach action. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  await assertTeamInOrg(orgId, teamId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Team',
    entityId: teamId,
    softDelete: (tx, deletedAt) =>
      tx.team.updateMany({ where: { id: teamId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
