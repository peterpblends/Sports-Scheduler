import { handler, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { can } from '@/lib/authz'
import { computeSeasonStandings } from '@/lib/schedule/standings'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

/**
 * League tables for a season, one per division.
 *
 * Same visibility rule as the schedule itself: a role holding `schedule:read` (the
 * privileged, draft-visible tier) sees standings computed off the live working set;
 * everyone else — coach, referee, viewer — sees them computed off the published
 * snapshot, which is nothing at all until something has been published.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { role } = await requirePermission(req, orgId, 'schedule:read:published')
  await assertSeasonInOrg(orgId, seasonId)

  const divisions = await computeSeasonStandings({
    orgId,
    seasonId,
    canReadDrafts: can(role, 'schedule:read'),
  })

  return Response.json({ divisions })
})
