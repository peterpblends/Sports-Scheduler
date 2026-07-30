import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui'
import { EntityHistory } from '@/components/activity-feed'
import { formatInstantInZone } from '@/lib/time'

/**
 * Game detail, with the per-entity history panel the spec asks for: who changed this
 * game and when, including any override reason that was recorded at the time.
 */
export default async function GamePage({
  params,
}: {
  params: Promise<{ orgSlug: string; gameId: string }>
}) {
  const { orgSlug, gameId } = await params
  const { role, orgId } = await requireOrgAccess(orgSlug, 'schedule:read:published')

  const game = await prisma.game.findFirst({
    where: {
      id: gameId,
      deletedAt: null,
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
    },
    include: {
      season: { include: { league: true } },
      division: true,
      homeTeam: true,
      awayTeam: true,
      field: { include: { venue: true } },
      officials: {
        where: { deletedAt: null },
        orderBy: { position: 'asc' },
        include: { referee: { include: { person: { select: { id: true, name: true } } } } },
      },
    },
  })
  if (!game) notFound()

  // A game only exists on the live working set. Roles that can read just the published
  // schedule should not reach a draft game's detail page.
  if (!can(role, 'schedule:read')) {
    const season = await prisma.season.findUniqueOrThrow({
      where: { id: game.seasonId },
      select: { publishedVersionId: true },
    })
    if (!season.publishedVersionId) notFound()
  }

  const history = await prisma.auditEvent.findMany({
    where: { entityType: 'Game', entityId: gameId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const officialHistory = await prisma.auditEvent.findMany({
    where: {
      entityType: 'GameOfficial',
      orgId,
      meta: { path: ['gameId'], equals: gameId },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const timezone = game.field?.venue.timezone ?? null

  return (
    <>
      <PageHeader
        title={`${game.homeTeam.name} v ${game.awayTeam.name}`}
        subtitle={`${game.season.league.name} · ${game.season.name} · ${game.division.name}${
          game.roundNumber !== null ? ` · round ${game.roundNumber}` : ''
        }`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link href={`/app/${orgSlug}/schedule`} className="text-ink-500 hover:underline dark:text-ink-300">
          ← Schedule
        </Link>
        {can(role, 'schedule:read') && (
          <Link
            href={`/app/${orgSlug}/seasons/${game.seasonId}/versions`}
            className="font-medium text-turf-600 hover:underline"
          >
            Version history →
          </Link>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold">Details</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Kickoff</dt>
              <dd className="text-right">
                {timezone ? formatInstantInZone(game.startTime, timezone) : game.startTime.toISOString()}
                <div className="text-xs text-ink-500 dark:text-ink-400">
                  {game.durationMinutes} minutes
                  {timezone && ` · ${timezone}`}
                </div>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Where</dt>
              <dd className="text-right">
                {game.field ? (
                  <>
                    {game.field.venue.name}
                    <div className="text-xs text-ink-500 dark:text-ink-400">{game.field.name}</div>
                  </>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">not placed</span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Status</dt>
              <dd>
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-900">
                  {game.status}
                </span>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Score</dt>
              <dd className="tabular-nums">
                {game.homeScore === null ? '—' : `${game.homeScore}–${game.awayScore}`}
              </dd>
            </div>
          </dl>
          {game.notes && (
            <p className="mt-3 border-t border-ink-200 pt-3 text-sm text-ink-600 dark:border-ink-700 dark:text-ink-300">
              {game.notes}
            </p>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold">Officials</h2>
          {game.officials.length === 0 ? (
            <div className="mt-3">
              <EmptyState>Nobody assigned yet.</EmptyState>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {game.officials.map((official) => (
                <li key={official.id} className="flex items-center justify-between gap-3 py-2">
                  <Link
                    href={`/app/${orgSlug}/people/${official.referee.person.id}`}
                    className="font-medium text-turf-600 hover:underline"
                  >
                    {official.referee.person.name}
                  </Link>
                  <span className="text-xs text-ink-500 dark:text-ink-400">
                    {official.position} · {official.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {can(role, 'audit:read') ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="text-base font-semibold">History</h2>
            <p className="mt-1 mb-3 text-sm text-ink-500 dark:text-ink-300">
              Who changed this game, when, and what they changed.
            </p>
            <EntityHistory
              events={history.map((event) => ({
                id: event.id,
                action: event.action,
                actorLabel: event.actorLabel,
                createdAt: event.createdAt,
                diff: event.diff,
                meta: event.meta,
              }))}
            />
          </Card>

          <Card>
            <h2 className="text-base font-semibold">Officiating changes</h2>
            <p className="mt-1 mb-3 text-sm text-ink-500 dark:text-ink-300">
              Assignments, responses and any override an assigner recorded.
            </p>
            <EntityHistory
              events={officialHistory.map((event) => ({
                id: event.id,
                action: event.action,
                actorLabel: event.actorLabel,
                createdAt: event.createdAt,
                diff: event.diff,
                meta: event.meta,
              }))}
            />
          </Card>
        </div>
      ) : (
        <div className="mt-4">
          <Alert kind="info">Your role cannot read the change history for this game.</Alert>
        </div>
      )}
    </>
  )
}
