import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Card, PageHeader } from '@/components/ui'
import {
  CalendarFeeds,
  ExportLinks,
  NotificationPreferences,
} from '@/components/subscriptions'
import { NOTIFICATION_DEFAULTS, NOTIFICATION_LABELS } from '@/lib/notify'
import { refereeForUser, staffTeamIds } from '@/lib/scope'

const KINDS = ['schedulePublished', 'gameRescheduled', 'assignmentChanged', 'rosterChanged'] as const

/**
 * How the schedule reaches one member: live calendar feeds, email preferences, and
 * one-off exports.
 *
 * Everything here is the caller's own. The team list a coach may subscribe to is the
 * one they are staff of, resolved from their session — matching the endpoint, which
 * refuses anything wider.
 */
export default async function SubscriptionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const { role, orgId, orgName, actor } = await requireOrgAccess(orgSlug, 'schedule:read:published')

  const [feeds, pref, ownReferee, ownTeamIds, season] = await Promise.all([
    prisma.calendarFeed.findMany({
      where: { orgId, userId: actor.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        team: { select: { name: true } },
        referee: { select: { person: { select: { name: true } } } },
        season: { select: { name: true } },
      },
    }),
    prisma.notificationPreference.findUnique({
      where: { userId_orgId: { userId: actor.userId, orgId } },
    }),
    refereeForUser(actor.userId, orgId),
    can(role, 'roster:write:own') ? staffTeamIds(actor.userId, orgId) : Promise.resolve([]),
    prisma.season.findFirst({
      where: { deletedAt: null, league: { orgId, deletedAt: null } },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      select: { id: true, name: true, league: { select: { name: true } } },
    }),
  ])

  // Org-wide readers may subscribe to any team; a coach only to their own.
  const canSeeAllTeams = can(role, 'schedule:read') || can(role, 'roster:write')
  const teams = await prisma.team.findMany({
    where: {
      deletedAt: null,
      division: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
      ...(canSeeAllTeams ? {} : { id: { in: ownTeamIds } }),
    },
    orderBy: [{ division: { name: 'asc' } }, { name: 'asc' }],
    include: { division: { select: { name: true } } },
  })

  const preferences = Object.fromEntries(
    KINDS.map((kind) => [kind, pref ? pref[kind] : NOTIFICATION_DEFAULTS[kind]]),
  ) as Record<(typeof KINDS)[number], boolean>

  return (
    <>
      <PageHeader
        title="Subscriptions and notifications"
        subtitle={`${orgName} · ${actor.email}`}
      />

      <div className="mb-6 text-sm">
        <Link href={`/app/${orgSlug}/schedule`} className="text-ink-500 hover:underline dark:text-ink-300">
          ← Schedule
        </Link>
      </div>

      <div className="space-y-4">
        <CalendarFeeds
          orgId={orgId}
          canSubscribeOrgWide={can(role, 'schedule:read') || can(role, 'structure:read')}
          isOfficial={ownReferee !== null}
          teams={teams.map((team) => ({
            id: team.id,
            name: team.name,
            divisionName: team.division.name,
          }))}
          feeds={feeds.map((feed) => ({
            id: feed.id,
            scope: feed.scope,
            label: feed.label,
            teamName: feed.team?.name ?? null,
            refereeName: feed.referee?.person.name ?? null,
            seasonName: feed.season?.name ?? null,
            createdAt: feed.createdAt.toISOString(),
            lastAccessedAt: feed.lastAccessedAt?.toISOString() ?? null,
          }))}
        />

        <NotificationPreferences
          orgId={orgId}
          initial={preferences}
          labels={NOTIFICATION_LABELS}
        />

        {season ? (
          <ExportLinks
            scheduleHref={`/api/orgs/${orgId}/seasons/${season.id}/export?kind=schedule`}
            assignmentsHref={
              can(role, 'official:read')
                ? `/api/orgs/${orgId}/seasons/${season.id}/export?kind=assignments`
                : null
            }
            printHref={`/app/${orgSlug}/schedule/print?seasonId=${season.id}`}
          />
        ) : (
          <Card>
            <h2 className="text-base font-semibold">One-off exports</h2>
            <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
              Nothing to export until a season exists.
            </p>
          </Card>
        )}
      </div>
    </>
  )
}
