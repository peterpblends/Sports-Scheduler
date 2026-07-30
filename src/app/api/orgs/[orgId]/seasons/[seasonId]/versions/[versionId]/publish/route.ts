import { z } from 'zod'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { publishVersion } from '@/lib/versions/service'

type Ctx = { params: Promise<{ orgId: string; seasonId: string; versionId: string }> }

const schema = z.object({ note: z.string().trim().max(500).optional() })

/**
 * Publishes a version.
 *
 * Publishing is the only thing that changes what coaches, referees and the public
 * see: everything else happens on the draft working set.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId, versionId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:publish')
  await assertSeasonInOrg(orgId, seasonId)
  const { note } = await parseBody(req, schema)

  const published = await publishVersion({ orgId, seasonId, versionId, actor, note })
  return Response.json({ published })
})
