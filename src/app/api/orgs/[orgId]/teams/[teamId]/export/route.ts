import { prisma } from '@/lib/prisma'
import { handler, requirePermission } from '@/lib/http'
import { assertTeamInOrg } from '@/lib/scope'
import { csvResponse, rosterToCsv } from '@/lib/export/csv'
import { recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string; teamId: string }> }

/**
 * CSV export of a team's current roster.
 *
 * Emits exactly the columns the importer reads, so an export can be edited in a
 * spreadsheet and imported straight back — which is the workflow a club secretary
 * actually has.
 *
 * `roster:read` is org-wide, so any member who can see rosters can export one. Reading
 * a roster and exporting it are the same disclosure; gating the second more tightly
 * than the first would be theatre.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:read')
  const team = await assertTeamInOrg(orgId, teamId)

  const memberships = await prisma.teamMembership.findMany({
    where: { teamId, deletedAt: null, activeTo: null },
    orderBy: [{ role: 'asc' }, { person: { name: 'asc' } }],
    include: { person: true },
  })

  await recordAudit({
    orgId,
    actorId: actor.userId,
    actorLabel: actor.email,
    entityType: 'Team',
    entityId: teamId,
    action: 'roster.exported',
    meta: { format: 'csv', rows: memberships.length },
  })

  return csvResponse(
    rosterToCsv(
      memberships.map((membership) => ({
        name: membership.person.name,
        email: membership.person.email,
        phone: membership.person.phone,
        role: membership.role,
        jerseyNumber: membership.jerseyNumber,
        dob: membership.person.dob,
        notes: membership.person.notes,
      })),
    ),
    `${team.name}-roster.csv`,
  )
})
