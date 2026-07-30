import { z } from 'zod'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { restoreVersion } from '@/lib/versions/service'

type Ctx = { params: Promise<{ orgId: string; seasonId: string; versionId: string }> }

const schema = z.object({
  note: z.string().trim().max(500).optional(),
  /** Statuses the restore must not overwrite. Played results are protected by default. */
  preserveStatuses: z
    .array(z.enum(['scheduled', 'confirmed', 'played', 'postponed', 'cancelled']))
    .optional(),
})

/**
 * Restores a prior version.
 *
 * This never deletes history: the restore writes a **new** version whose content
 * matches the one restored from, and every version in between stays exactly where it
 * is. The games it replaces are soft-deleted, not dropped.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId, versionId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:restore')
  await assertSeasonInOrg(orgId, seasonId)
  const { note, preserveStatuses } = await parseBody(req, schema)

  const result = await restoreVersion({
    orgId,
    seasonId,
    versionId,
    actor,
    note,
    preserveStatuses,
  })

  return Response.json(result, { status: 201 })
})
