import { prisma } from '@/lib/prisma'
import { badRequest, handler, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { can } from '@/lib/authz'
import { readSchedule } from '@/lib/schedule/read'
import { assignmentsToCsv, csvResponse, scheduleToCsv } from '@/lib/export/csv'
import { recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

/**
 * CSV export of a season.
 *
 * Reads through the same `readSchedule` every view uses, so the published/draft split
 * holds here too: a coach exporting gets the published snapshot, a scheduler gets the
 * live draft. An export is otherwise the easiest way to leak an unpublished schedule.
 *
 * `kind=assignments` needs `official:read` — who is refereeing is not part of what a
 * coach or a viewer is entitled to.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { role, actor } = await requirePermission(req, orgId, 'schedule:read:published')
  await assertSeasonInOrg(orgId, seasonId)

  const params = new URL(req.url).searchParams
  const kind = params.get('kind') ?? 'schedule'
  if (kind !== 'schedule' && kind !== 'assignments') {
    throw badRequest('kind must be "schedule" or "assignments".')
  }
  if (kind === 'assignments' && !can(role, 'official:read')) {
    throw badRequest('Your role cannot export officiating assignments.')
  }

  const season = await prisma.season.findUniqueOrThrow({
    where: { id: seasonId },
    select: { name: true, league: { select: { name: true } } },
  })

  const schedule = await readSchedule({
    orgId,
    seasonId,
    canReadDrafts: can(role, 'schedule:read'),
    filter: {
      divisionId: params.get('divisionId'),
      teamId: params.get('teamId'),
      venueId: params.get('venueId'),
      refereeId: params.get('refereeId'),
    },
  })

  // Exports leave the building, so they are worth a line in the trail.
  await recordAudit({
    orgId,
    actorId: actor.userId,
    actorLabel: actor.email,
    entityType: 'Season',
    entityId: seasonId,
    action: 'schedule.exported',
    meta: { kind, format: 'csv', rows: schedule.rows.length, source: schedule.source },
  })

  const slug = `${season.league.name}-${season.name}-${kind}`
  const body =
    kind === 'assignments' ? assignmentsToCsv(schedule.rows) : scheduleToCsv(schedule.rows)

  return csvResponse(body, `${slug}.csv`)
})
