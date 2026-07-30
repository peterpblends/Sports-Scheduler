import { prisma } from '@/lib/prisma'
import { conflict, handler, parseBody, requirePermission } from '@/lib/http'
import { createTeamMembershipSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertJerseyFree } from '@/lib/roster'
import { assertPersonInOrg, assertTeamInOrg, requireTeamRosterWrite } from '@/lib/scope'
import { parseCalendarDate } from '@/lib/time'
import type { TeamMembership } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; teamId: string }> }

const snapshot = (m: TeamMembership) => ({
  teamId: m.teamId,
  personId: m.personId,
  role: m.role,
  jerseyNumber: m.jerseyNumber,
  activeFrom: m.activeFrom?.toISOString() ?? null,
  activeTo: m.activeTo?.toISOString() ?? null,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId } = await ctx.params
  await requirePermission(req, orgId, 'roster:read')
  await assertTeamInOrg(orgId, teamId)

  const members = await prisma.teamMembership.findMany({
    where: { teamId, deletedAt: null },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: { person: { select: { id: true, name: true, email: true, phone: true } } },
  })

  return Response.json({ members })
})

/**
 * Add someone to this team's roster.
 *
 * `requireTeamRosterWrite` is the gate: org-wide `roster:write` passes for any
 * team, `roster:write:own` passes only for a team the caller is staff of, and
 * everything else is rejected. The team id comes from the URL, so a coach cannot
 * redirect the write by way of the body.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId } = await ctx.params
  const { actor, scoped } = await requireTeamRosterWrite(req, orgId, teamId)
  const data = await parseBody(req, createTeamMembershipSchema)

  // The person must also be in this org — no importing another tenant's people.
  await assertPersonInOrg(orgId, data.personId)

  const existing = await prisma.teamMembership.findFirst({
    where: { teamId, personId: data.personId, role: data.role, deletedAt: null },
  })
  if (existing) throw conflict('That person already holds this role on the team.')

  if (data.jerseyNumber) await assertJerseyFree(teamId, data.jerseyNumber)

  const membership = await createWithAudit({
    orgId,
    actor,
    entityType: 'TeamMembership',
    action: 'roster.member_added',
    id: (m) => m.id,
    snapshot,
    meta: { teamId, personId: data.personId, viaOwnTeamScope: scoped },
    create: (tx) =>
      tx.teamMembership.create({
        data: {
          teamId,
          personId: data.personId,
          role: data.role,
          jerseyNumber: data.jerseyNumber ?? null,
          activeFrom: data.startDate ? parseCalendarDate(data.startDate) : null,
          activeTo: data.endDate ? parseCalendarDate(data.endDate) : null,
        },
      }),
  })

  return Response.json({ member: { id: membership.id, ...snapshot(membership) } }, { status: 201 })
})
