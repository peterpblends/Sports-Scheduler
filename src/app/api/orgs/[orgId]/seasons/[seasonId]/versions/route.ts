import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { createVersion } from '@/lib/versions/service'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

/** Version list for a season, newest first. */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  await requirePermission(req, orgId, 'schedule:read')
  await assertSeasonInOrg(orgId, seasonId)

  const [versions, season] = await Promise.all([
    prisma.scheduleVersion.findMany({
      where: { seasonId },
      orderBy: { number: 'desc' },
      // An explicit select, and `snapshot` is deliberately not in it. `include`
      // without a select pulls every column, and `snapshot` holds one entry per game
      // in the season — listing a few dozen versions of a large season would transfer
      // and parse the entire schedule history to render a list of labels.
      select: {
        id: true,
        number: true,
        label: true,
        note: true,
        status: true,
        source: true,
        authorLabel: true,
        createdAt: true,
        publishedAt: true,
        restoredFromId: true,
        gameCount: true,
        author: { select: { name: true, email: true } },
      },
      // Bounded. Versions accumulate for the life of a season and a list of every one
      // ever made is not something any caller needs in a single response.
      take: 200,
    }),
    prisma.season.findUniqueOrThrow({
      where: { id: seasonId },
      select: { publishedVersionId: true },
    }),
  ])

  return Response.json({
    publishedVersionId: season.publishedVersionId,
    versions: versions.map((version) => ({
      id: version.id,
      number: version.number,
      label: version.label,
      note: version.note,
      status: version.status,
      source: version.source,
      // authorLabel is kept even if the account is later removed, so history stays legible.
      author: version.author?.name ?? version.authorLabel,
      createdAt: version.createdAt,
      publishedAt: version.publishedAt,
      restoredFromId: version.restoredFromId,
      gameCount: version.gameCount,
      isPublished: version.id === season.publishedVersionId,
    })),
  })
})

const saveSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(500).optional(),
})

/**
 * Manual save: freezes the season's current games as a new version.
 *
 * The spec asks for a version on every generation *and* every manual save. Generation
 * creates its own; this is the explicit "snapshot where we are now" an admin reaches
 * for before hand-editing.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:edit')
  await assertSeasonInOrg(orgId, seasonId)
  const { label, note } = await parseBody(req, saveSchema)

  const version = await prisma.$transaction((tx) =>
    createVersion({ orgId, seasonId, actor, source: 'manual_save', label, note }, tx),
  )

  return Response.json({ version }, { status: 201 })
})
