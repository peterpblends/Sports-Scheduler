import { handler, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { unpublishSeason } from '@/lib/versions/service'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

/** Takes the season back to having nothing published. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:publish')
  await assertSeasonInOrg(orgId, seasonId)

  await unpublishSeason({ orgId, seasonId, actor })
  return Response.json({ ok: true })
})
