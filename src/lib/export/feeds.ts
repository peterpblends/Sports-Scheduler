import { prisma } from '../prisma'
import { generateToken, hashToken } from '../tokens'
import { can } from '../authz'
import { readSchedule, type ScheduleRow } from '../schedule/read'
import { appUrl } from '../mailer'
import type { CalendarFeedScope } from '@prisma/client'

/**
 * Live calendar subscriptions.
 *
 * A calendar client fetches a URL on a timer with no cookie, so the credential has to
 * be the URL. That makes two things load-bearing:
 *
 *  1. **The token is a bearer credential, and is treated like one.** 256 bits of
 *     entropy, stored as a SHA-256 digest, shown once at creation, revocable.
 *  2. **Authorization is re-derived on every fetch from the owner's live membership**,
 *     never frozen into the feed. Removing someone from the org, or dropping them from
 *     coach to viewer, changes what their existing URL returns on the next poll —
 *     without anyone having to remember the feed exists.
 *
 * A feed never serves a draft. Everyone who subscribes to a calendar is, by definition,
 * outside the office: they get the published snapshot, same as the public page.
 */

export type FeedResolution =
  | { ok: true; rows: ScheduleRow[]; name: string; description: string }
  | { ok: false; reason: 'not_found' | 'revoked' | 'no_access' | 'nothing_published' }

export function feedUrl(token: string): string {
  return appUrl(`/api/feeds/${token}.ics`)
}

export async function createFeed(input: {
  orgId: string
  userId: string
  scope: CalendarFeedScope
  label: string
  teamId?: string | null
  refereeId?: string | null
  seasonId?: string | null
}): Promise<{ id: string; token: string; url: string }> {
  const token = generateToken()
  const feed = await prisma.calendarFeed.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      scope: input.scope,
      label: input.label,
      teamId: input.teamId ?? null,
      refereeId: input.refereeId ?? null,
      seasonId: input.seasonId ?? null,
      tokenHash: hashToken(token),
    },
    select: { id: true },
  })
  // The only moment the plaintext token exists. It is not recoverable afterwards.
  return { id: feed.id, token, url: feedUrl(token) }
}

/**
 * Resolves a feed token to the rows it may serve.
 *
 * Deliberately returns a reason rather than throwing: the route turns every failure
 * into the same 404, so a probe cannot tell a revoked token from a wrong one.
 */
export async function resolveFeed(token: string): Promise<FeedResolution> {
  const feed = await prisma.calendarFeed.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      org: { select: { id: true, name: true } },
      team: { select: { id: true, name: true, divisionId: true, deletedAt: true } },
      referee: {
        select: { id: true, deletedAt: true, person: { select: { name: true } } },
      },
    },
  })

  if (!feed) return { ok: false, reason: 'not_found' }
  if (feed.revokedAt) return { ok: false, reason: 'revoked' }

  // Live membership, not a stored role. This is what makes revoking access enough.
  const membership = await prisma.membership.findFirst({
    where: { userId: feed.userId, orgId: feed.orgId, deletedAt: null },
    select: { role: true },
  })
  if (!membership) return { ok: false, reason: 'no_access' }
  if (!can(membership.role, 'schedule:read:published')) return { ok: false, reason: 'no_access' }

  // A deleted team or official leaves the feed pointing at nothing.
  if (feed.scope === 'team' && (!feed.team || feed.team.deletedAt)) {
    return { ok: false, reason: 'not_found' }
  }
  if (feed.scope === 'referee' && (!feed.referee || feed.referee.deletedAt)) {
    return { ok: false, reason: 'not_found' }
  }

  const seasonId = feed.seasonId ?? (await activeSeasonId(feed.orgId))
  if (!seasonId) return { ok: false, reason: 'nothing_published' }

  const schedule = await readSchedule({
    orgId: feed.orgId,
    seasonId,
    // Never a draft, whatever the owner's role would otherwise allow.
    canReadDrafts: false,
    filter: {
      teamId: feed.scope === 'team' ? feed.teamId : null,
      refereeId: feed.scope === 'referee' ? feed.refereeId : null,
    },
  })

  if (schedule.source === 'none') return { ok: false, reason: 'nothing_published' }

  await prisma.calendarFeed.update({
    where: { id: feed.id },
    data: { lastAccessedAt: new Date() },
  })

  const scopeLabel =
    feed.scope === 'team'
      ? (feed.team?.name ?? 'Team')
      : feed.scope === 'referee'
        ? (feed.referee?.person.name ?? 'Official')
        : feed.org.name

  return {
    ok: true,
    rows: schedule.rows,
    name: `${feed.org.name} — ${scopeLabel}`,
    description:
      feed.scope === 'referee'
        ? `Officiating assignments for ${scopeLabel}. Published schedule only.`
        : `Published schedule for ${scopeLabel}.`,
  }
}

/** The season a feed follows when it is not pinned to one: the active one, else newest. */
async function activeSeasonId(orgId: string): Promise<string | null> {
  const active = await prisma.season.findFirst({
    where: { deletedAt: null, status: 'active', league: { orgId, deletedAt: null } },
    orderBy: { startDate: 'desc' },
    select: { id: true },
  })
  if (active) return active.id

  const newest = await prisma.season.findFirst({
    where: { deletedAt: null, league: { orgId, deletedAt: null } },
    orderBy: { startDate: 'desc' },
    select: { id: true },
  })
  return newest?.id ?? null
}
