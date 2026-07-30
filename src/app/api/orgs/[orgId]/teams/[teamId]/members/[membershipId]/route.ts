import { prisma } from '@/lib/prisma'
import { notifyRosterChanged } from '@/lib/notify'
import { handler, notFound, parseBody } from '@/lib/http'
import { updateTeamMembershipSchema } from '@/lib/validation'
import { softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { requireTeamRosterWrite } from '@/lib/scope'
import { parseCalendarDate } from '@/lib/time'
import { assertJerseyFree } from '@/lib/roster'
import type { TeamMembership } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; teamId: string; membershipId: string }> }

const snapshot = (m: TeamMembership) => ({
  role: m.role,
  jerseyNumber: m.jerseyNumber,
  activeFrom: m.activeFrom?.toISOString() ?? null,
  activeTo: m.activeTo?.toISOString() ?? null,
})

/**
 * Loads a roster row, requiring it to belong to the team named in the URL.
 * Without this, a coach with write access to team A could pass a membership id
 * from team B and edit it.
 */
async function loadMembership(teamId: string, membershipId: string) {
  const membership = await prisma.teamMembership.findFirst({
    where: { id: membershipId, teamId, deletedAt: null },
  })
  if (!membership) throw notFound('Roster entry not found.')
  return membership
}

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId, membershipId } = await ctx.params
  const { actor, scoped } = await requireTeamRosterWrite(req, orgId, teamId)
  const before = await loadMembership(teamId, membershipId)
  const patch = await parseBody(req, updateTeamMembershipSchema)

  if (patch.jerseyNumber) await assertJerseyFree(teamId, patch.jerseyNumber, membershipId)

  const membership = await updateWithAudit({
    orgId,
    actor,
    entityType: 'TeamMembership',
    entityId: membershipId,
    action: 'roster.member_updated',
    before: snapshot(before),
    snapshot,
    meta: { teamId, personId: before.personId, viaOwnTeamScope: scoped },
    update: (tx) =>
      tx.teamMembership.update({
        where: { id: membershipId },
        data: {
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.jerseyNumber !== undefined ? { jerseyNumber: patch.jerseyNumber ?? null } : {}),
          ...(patch.startDate !== undefined
            ? { activeFrom: patch.startDate ? parseCalendarDate(patch.startDate) : null }
            : {}),
          ...(patch.endDate !== undefined
            ? { activeTo: patch.endDate ? parseCalendarDate(patch.endDate) : null }
            : {}),
        },
      }),
  })

  return Response.json({ member: { id: membership.id, ...snapshot(membership) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId, membershipId } = await ctx.params
  const { actor, scoped } = await requireTeamRosterWrite(req, orgId, teamId)
  const before = await loadMembership(teamId, membershipId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'TeamMembership',
    entityId: membershipId,
    action: 'roster.member_removed',
    meta: { teamId, personId: before.personId, viaOwnTeamScope: scoped },
    // Scoped by teamId as well as id, so the URL's team is authoritative.
    softDelete: (tx, deletedAt) =>
      tx.teamMembership.updateMany({
        where: { id: membershipId, teamId, deletedAt: null },
        data: { deletedAt },
      }),
  })

  const notified = await notifyRosterChanged({
    orgId,
    teamId,
    actorUserId: actor.userId,
    actorLabel: actor.email,
    summary: 'a member was removed',
  })

  return Response.json({ ok: true, notified })
})
