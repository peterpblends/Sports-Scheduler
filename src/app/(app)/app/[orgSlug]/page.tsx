import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { ROLE_DESCRIPTIONS, can } from '@/lib/authz'
import { Alert, Card, EmptyState, PageHeader, RoleBadge } from '@/components/ui'
import { readSchedule, type ScheduleRow } from '@/lib/schedule/read'
import { refereeForUser } from '@/lib/scope'
import { loadCoachDashboard, loadRefereeDashboard, loadViewerDashboard } from '@/lib/dashboard'
import {
  CoachDashboardView,
  RefereeDashboardView,
  ViewerDashboardView,
} from '@/components/dashboards'
import { QuickStart } from '@/components/quick-start'
import { formatInstantInZone } from '@/lib/time'

/**
 * The dashboard, answering "what needs me today" rather than "what is this app".
 *
 * Which dashboard you get is decided by role, using the same permission matrix the
 * server enforces. Rather than one page accumulating a conditional per panel, the
 * three read-mostly roles each have their own view and loader:
 *
 *  * a **coach** leads with their next fixture, their teams and their roster;
 *  * a **referee** leads with what is waiting on their answer;
 *  * a **viewer** leads with what is on and how to follow it.
 *
 * Organizers keep the operational view below, because their question really is
 * "what is unfinished across the whole org" — unstaffed games, an unpublished draft,
 * a season that is not ready to schedule.
 *
 * Role is a *presentation* choice here. Every link on every one of these leads to a
 * page that re-checks permission, and every endpoint behind them re-checks again.
 */
export default async function OrgDashboard({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const { role, orgId, orgName, actor } = await requireOrgAccess(orgSlug, 'org:read')

  const canReadDrafts = can(role, 'schedule:read')
  const canAssign = can(role, 'official:assign')
  const isOrganizer = can(role, 'schedule:edit')

  const [org, seasons] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    prisma.season.findMany({
      where: { deletedAt: null, league: { orgId, deletedAt: null } },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: {
        league: { select: { name: true } },
        publishedVersion: { select: { number: true, publishedAt: true } },
        _count: {
          select: {
            games: { where: { deletedAt: null } },
            divisions: { where: { deletedAt: null } },
          },
        },
      },
    }),
  ])

  const season = seasons.find((candidate) => candidate.status === 'active') ?? seasons[0] ?? null
  const seasonLabel = season ? `${season.league.name} · ${season.name}` : 'No seasons yet'

  const header = (
    <PageHeader
      title={orgName}
      subtitle={`${seasonLabel} · times shown in each venue's local zone`}
      action={<RoleBadge role={role} />}
    />
  )

  // --- referee -------------------------------------------------------------

  if (can(role, 'official:read:own') && !isOrganizer) {
    const referee = await refereeForUser(actor.userId, orgId)
    const board = referee
      ? await loadRefereeDashboard({
          orgId,
          seasonId: season?.id ?? null,
          refereeId: referee.id,
          canReadDrafts,
        })
      : null

    // Opened for someone who has nothing on their plate yet: no referee record at
    // all, or a record with no games either way. That is exactly when the four steps
    // are worth reading, and it closes itself once they are officiating.
    const refereeIsNew =
      !referee ||
      !board ||
      board.accepted.length + board.awaitingAnswer.length + board.pendingRequests.length === 0

    return (
      <>
        {header}
        <QuickStart
          role={role}
          orgSlug={orgSlug}
          publicSlug={org.slug}
          seasonId={season?.id ?? null}
          defaultOpen={refereeIsNew}
        />
        <RefereeDashboardView
          board={board}
          orgSlug={orgSlug}
          refereeName={referee?.person.name ?? null}
        />
      </>
    )
  }

  // --- coach ---------------------------------------------------------------

  if (can(role, 'roster:write:own') && !isOrganizer) {
    const data = await loadCoachDashboard({
      orgId,
      seasonId: season?.id ?? null,
      userId: actor.userId,
      canReadDrafts,
    })

    return (
      <>
        {header}
        <QuickStart
          role={role}
          orgSlug={orgSlug}
          publicSlug={org.slug}
          seasonId={season?.id ?? null}
          teamId={data.teams[0]?.id ?? null}
          // A coach with no team yet, or no fixtures to look at, is the one who needs
          // telling where things are.
          defaultOpen={data.teams.length === 0 || data.upcoming.length === 0}
        />
        <CoachDashboardView data={data} orgSlug={orgSlug} />
      </>
    )
  }

  // --- viewer --------------------------------------------------------------

  if (!isOrganizer) {
    const data = await loadViewerDashboard({
      orgId,
      seasonId: season?.id ?? null,
      canReadDrafts,
    })

    return (
      <>
        {header}
        <QuickStart
          role={role}
          orgSlug={orgSlug}
          publicSlug={org.slug}
          seasonId={season?.id ?? null}
          // Nothing published means an empty page; the guide explains why rather than
          // leaving them staring at it.
          defaultOpen={data.source === 'none' || data.upcoming.length === 0}
        />
        <ViewerDashboardView data={data} orgSlug={orgSlug} publicSlug={org.slug} />
      </>
    )
  }

  // --- organizer -----------------------------------------------------------

  const counts = await Promise.all([
    prisma.league.count({ where: { orgId, deletedAt: null } }),
    prisma.team.count({
      where: { deletedAt: null, division: { season: { league: { orgId, deletedAt: null } } } },
    }),
    prisma.field.count({ where: { deletedAt: null, venue: { orgId, deletedAt: null } } }),
    prisma.timeSlot.count({
      where: { deletedAt: null, field: { deletedAt: null, venue: { orgId, deletedAt: null } } },
    }),
  ]).then(([leagues, teams, fields, slots]) => ({ leagues, teams, fields, slots }))

  const schedule = season
    ? await readSchedule({ orgId, seasonId: season.id, canReadDrafts })
    : null

  const now = new Date()
  const upcoming = (schedule?.rows ?? [])
    .filter((row) => row.startTime.getTime() >= now.getTime() && row.status !== 'cancelled')
    .slice(0, 6)

  const unstaffed = canAssign
    ? (schedule?.rows ?? []).filter(
        (row) =>
          row.startTime.getTime() >= now.getTime() &&
          row.status !== 'cancelled' &&
          row.officials.filter((official) => official.status !== 'declined').length === 0,
      ).length
    : 0

  const openRequests = can(role, 'official:request:review')
    ? await prisma.officiatingRequest.count({
        where: {
          status: 'pending',
          deletedAt: null,
          game: {
            deletedAt: null,
            season: { deletedAt: null, league: { orgId, deletedAt: null } },
          },
        },
      })
    : 0

  const setupDone =
    counts.leagues > 0 && counts.teams >= 2 && counts.fields > 0 && counts.slots > 0

  return (
    <>
      {header}

      <QuickStart
        role={role}
        orgSlug={orgSlug}
        publicSlug={org.slug}
        seasonId={season?.id ?? null}
        // Open while the org is genuinely unfinished: not ready to schedule, no
        // season yet, or a draft that has never been published — the publish step is
        // the one organizers most often miss, and it is invisible until told.
        defaultOpen={!setupDone || !season || (season._count.games > 0 && !season.publishedVersion)}
      />

      {!setupDone && can(role, 'structure:write') && (
        <div className="mb-6">
          <Alert kind="info">
            This organization is not ready to schedule yet.{' '}
            <Link href={`/app/${orgSlug}/setup`} className="underline">
              Open the setup checklist
            </Link>{' '}
            — it walks through leagues, teams, venues and field availability in order.
          </Alert>
        </div>
      )}

      {season && !season.publishedVersion && season._count.games > 0 && (
        <div className="mb-6">
          <Alert>
            {season._count.games} games exist in the draft for {season.name}, but nothing is
            published — coaches, referees and viewers see no schedule at all.{' '}
            <Link href={`/app/${orgSlug}/seasons/${season.id}/versions`} className="underline">
              Publish a version
            </Link>
          </Alert>
        </div>
      )}

      {openRequests > 0 && (
        <div className="mb-6">
          <Alert kind="info">
            {openRequests} referee{openRequests === 1 ? '' : 's'} {openRequests === 1 ? 'has' : 'have'}{' '}
            asked for a game.{' '}
            <Link href={`/app/${orgSlug}/schedule/officials`} className="underline">
              Answer them
            </Link>{' '}
            — approving is the quickest way to close a gap in a crew.
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label={season ? `Games in ${season.name}` : 'Games'}
          value={schedule?.totalBeforeFilter ?? 0}
          href={`/app/${orgSlug}/schedule`}
          hrefLabel="Open the schedule"
        />
        {canAssign && (
          <Stat
            label="Upcoming, no officials"
            value={unstaffed}
            tone={unstaffed > 0 ? 'warn' : 'ok'}
            href={`/app/${orgSlug}/schedule/officials`}
            hrefLabel="Assignment board"
          />
        )}
        <Stat label="Teams" value={counts.teams} href={`/app/${orgSlug}/leagues`} hrefLabel="Leagues" />
        <Stat label="Fields" value={counts.fields} href={`/app/${orgSlug}/venues`} hrefLabel="Venues" />
      </div>

      <div className="mt-6">
        <OrganizerGameList
          title="Next up"
          subtitle={seasonLabel}
          rows={upcoming}
          orgSlug={orgSlug}
          emptyLabel={
            schedule?.source === 'none'
              ? 'Nothing has been published for this season yet.'
              : 'No upcoming games.'
          }
        />
      </div>

      {seasons.length > 0 && (
        <Card className="mt-6">
          <h2 className="text-base font-semibold">Seasons</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Season</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Divisions</th>
                  <th className="pb-2 pr-4 font-medium">Games</th>
                  <th className="pb-2 font-medium">Published</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {seasons.map((candidate) => (
                  <tr key={candidate.id}>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/app/${orgSlug}/seasons/${candidate.id}`}
                        className="font-medium text-turf-600 hover:underline"
                      >
                        {candidate.league.name} · {candidate.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      <span className="rounded-full bg-ink-100 px-2 py-0.5 dark:bg-ink-900">
                        {candidate.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{candidate._count.divisions}</td>
                    <td className="py-2 pr-4 tabular-nums">{candidate._count.games}</td>
                    <td className="py-2 text-xs">
                      {candidate.publishedVersion ? (
                        <span className="text-turf-700 dark:text-turf-500">
                          v{candidate.publishedVersion.number}
                        </span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">nothing yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
          Your role
        </div>
        <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">{ROLE_DESCRIPTIONS[role]}</p>
      </Card>
    </>
  )
}

function Stat({
  label,
  value,
  href,
  hrefLabel,
  tone = 'ok',
}: {
  label: string
  value: number
  href?: string
  hrefLabel?: string
  tone?: 'ok' | 'warn'
}) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">{label}</div>
      <div
        className={
          tone === 'warn'
            ? 'mt-1 text-3xl font-semibold tabular-nums text-amber-700 dark:text-amber-300'
            : 'mt-1 text-3xl font-semibold tabular-nums'
        }
      >
        {value}
      </div>
      {href && hrefLabel && (
        <Link href={href} className="mt-2 inline-block text-sm text-turf-600 hover:underline">
          {hrefLabel}
        </Link>
      )}
    </Card>
  )
}

function OrganizerGameList({
  title,
  subtitle,
  rows,
  orgSlug,
  emptyLabel,
}: {
  title: string
  subtitle: string
  rows: ScheduleRow[]
  orgSlug: string
  emptyLabel: string
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">{subtitle}</p>
      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState>{emptyLabel}</EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <span>
                <Link
                  href={`/app/${orgSlug}/games/${row.id}`}
                  className="font-medium text-turf-600 hover:underline"
                >
                  {row.homeTeamName} v {row.awayTeamName}
                </Link>
                <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                  {row.divisionName}
                  {row.venueName && ` · ${row.venueName} · ${row.fieldName}`}
                </span>
              </span>
              <span className="text-xs tabular-nums text-ink-600 dark:text-ink-300">
                {formatInstantInZone(row.startTime, row.timezone)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
