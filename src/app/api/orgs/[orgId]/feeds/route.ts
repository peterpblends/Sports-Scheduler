import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { forbidden, handler, parseBody, requirePermission } from '@/lib/http'
import { assertSeasonInOrg, assertTeamInOrg, refereeForUser, staffTeamIds } from '@/lib/scope'
import { can } from '@/lib/authz'
import { createFeed } from '@/lib/export/feeds'
import { recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string }> }

const schema = z.object({
  scope: z.enum(['org', 'team', 'referee']),
  teamId: z.string().min(1).nullish(),
  refereeId: z.string().min(1).nullish(),
  seasonId: z.string().min(1).nullish(),
  label: z.string().trim().min(1).max(120).optional(),
})

/** A user's own feeds. Never anyone else's — a feed URL is a credential. */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:read:published')

  const feeds = await prisma.calendarFeed.findMany({
    where: { orgId, userId: actor.userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      team: { select: { name: true } },
      referee: { select: { person: { select: { name: true } } } },
      season: { select: { name: true } },
    },
  })

  return Response.json({
    feeds: feeds.map((feed) => ({
      id: feed.id,
      scope: feed.scope,
      label: feed.label,
      teamName: feed.team?.name ?? null,
      refereeName: feed.referee?.person.name ?? null,
      seasonName: feed.season?.name ?? null,
      createdAt: feed.createdAt,
      lastAccessedAt: feed.lastAccessedAt,
      // The token is not stored in plaintext, so an existing feed's URL cannot be
      // shown again. Losing it means creating a new one, which is the right trade.
    })),
  })
})

/**
 * Creates a subscription URL.
 *
 * The scope is checked against what this caller may actually see, not just against
 * their role: a coach may subscribe to a team they are staff of, and a referee to their
 * own assignments. Otherwise a feed would be a way to read past an own-scope
 * restriction at leisure.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor, role } = await requirePermission(req, orgId, 'schedule:read:published')
  const input = await parseBody(req, schema)

  if (input.seasonId) await assertSeasonInOrg(orgId, input.seasonId)

  let label = input.label ?? ''
  let teamId: string | null = null
  let refereeId: string | null = null

  if (input.scope === 'team') {
    if (!input.teamId) throw forbidden('A team feed needs a teamId.')
    const team = await assertTeamInOrg(orgId, input.teamId)
    // Org-wide readers may subscribe to any team; a coach only to their own.
    if (!can(role, 'roster:write') && !can(role, 'schedule:read')) {
      const own = await staffTeamIds(actor.userId, orgId)
      if (!own.includes(input.teamId)) {
        throw forbidden('You can only subscribe to a team you are staff of.')
      }
    }
    teamId = team.id
    label ||= `${team.name} fixtures`
  }

  if (input.scope === 'referee') {
    const own = await refereeForUser(actor.userId, orgId)
    const target = input.refereeId ?? own?.id
    if (!target) throw forbidden('You are not registered as an official.')
    // Anyone may subscribe to their own assignments; only an assigner to someone else's.
    if (target !== own?.id && !can(role, 'official:read')) {
      throw forbidden('You can only subscribe to your own assignments.')
    }
    const referee = await prisma.referee.findFirst({
      where: { id: target, deletedAt: null, person: { orgId, deletedAt: null } },
      include: { person: { select: { name: true } } },
    })
    if (!referee) throw forbidden('That official is not in this organization.')
    refereeId = referee.id
    label ||= `${referee.person.name} assignments`
  }

  if (input.scope === 'org') {
    label ||= 'All fixtures'
  }

  const feed = await createFeed({
    orgId,
    userId: actor.userId,
    scope: input.scope,
    label,
    teamId,
    refereeId,
    seasonId: input.seasonId ?? null,
  })

  await recordAudit({
    orgId,
    actorId: actor.userId,
    actorLabel: actor.email,
    entityType: 'CalendarFeed',
    entityId: feed.id,
    action: 'feed.created',
    diff: { scope: { before: null, after: input.scope } },
    meta: { scope: input.scope, teamId, refereeId, seasonId: input.seasonId ?? null, label },
  })

  return Response.json(
    {
      feed: { id: feed.id, label, scope: input.scope },
      // Returned once and never again: the server keeps only the digest.
      url: feed.url,
    },
    { status: 201 },
  )
})
