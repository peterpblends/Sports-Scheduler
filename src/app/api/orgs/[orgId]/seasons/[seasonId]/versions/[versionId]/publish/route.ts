import { z } from 'zod'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { publishVersion } from '@/lib/versions/service'
import { notifySchedulePublished } from '@/lib/notify'

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

  // After the transaction, never inside it: a mail send must not be able to roll back a
  // publish, and a transaction must not be held open across an SMTP call.
  const notified = await notifySchedulePublished({
    orgId,
    seasonId,
    versionNumber: published.number,
    actorLabel: actor.email,
  })

  return Response.json({ published, notified })
})
