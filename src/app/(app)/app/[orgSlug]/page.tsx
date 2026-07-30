import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { ROLE_DESCRIPTIONS, can } from '@/lib/authz'
import { Alert, Card, EmptyState, PageHeader, RoleBadge } from '@/components/ui'
import { readSchedule, type ScheduleRow } from '@/lib/schedule/read'
import { refereeForUser, staffTeamIds } from '@/lib/scope'
import { formatInstantInZone } from '@/lib/time'

/**
 * The dashboard, answering "what needs me today" rather than "what is this app".
 *
 * What it shows is decided by role, and by the same permission matrix the server
 * enforces: an assigner sees unstaffed games, a scheduler sees whether the draft has
 * diverged from what is published, a coach sees their own team's next fixtures, a
 * referee sees the assignments waiting on their answer. Nothing here is a second
 * source of truth — every panel links to the page that owns it.
 */
export default async function OrgDashboard({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const { role, orgId, orgName, actor } = await requireOrgAccess(orgSlug, 'org:read')

  const canReadDrafts = can(role, 'schedule:read')
  const canAssign = can(role, 'official:assign')

  const [org, seasons, counts] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    prisma.season.findMany({
      where: { deletedAt: null, league: { orgId, deletedAt: null } },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: {
        league: { select: { name: true } },
        publishedVersion: { select: { number: true, publishedAt: true } },
        _count: { select: { games: { where: { deletedAt: null } }, divisions: { where: { deletedAt: null } } } },
      },
    }),
    Promise.all([
      prisma.league.count({ where: { orgId, deletedAt: null } }),
      prisma.team.count({
        where: { deletedAt: null, division: { season: { league: { orgId, deletedAt: null } } } },
      }),
      prisma.field.count({ where: { deletedAt: null, venue: { orgId, deletedAt: null } } }),
      prisma.referee.count({ where: { deletedAt: null, person: { orgId, deletedAt: null } } }),
      prisma.timeSlot.count({
        where: { deletedAt: null, field: { deletedAt: null, venue: { orgId, deletedAt: null } } },
      }),
    ]).then(([leagues, teams, fields, referees, slots]) => ({
      leagues,
      teams,
      fields,
      referees,
      slots,
    })),
  ])

  const season = seasons.find((candidate) => candidate.status === 'active') ?? seasons[0] ?? null

  const schedule = season
    ? await readSchedule({ orgId, seasonId: season.id, canReadDrafts })
    : null

  const now = new Date()
  const upcoming = (schedule?.rows ?? [])
    .filter((row) => row.startTime.getTime() >= now.getTime() && row.status !== 'cancelled')
    .slice(0, 6)

  // Own-scope panels. A coach's teams and a referee's assignments are resolved from
  // their session, never from a query parameter.
  const [ownTeamIds, ownReferee] = await Promise.all([
    can(role, 'roster:write:own') ? staffTeamIds(actor.userId, orgId) : Promise.resolve([]),
    can(role, 'official:read:own') ? refereeForUser(actor.userId, orgId) : Promise.resolve(null),
  ])

  const ownTeamGames = ownTeamIds.length
    ? (schedule?.rows ?? [])
        .filter(
          (row) =>
            row.startTime.getTime() >= now.getTime() &&
            (ownTeamIds.includes(row.homeTeamId) || ownTeamIds.includes(row.awayTeamId)),
        )
        .slice(0, 6)
    : []

  const ownAssignments = ownReferee
    ? (schedule?.rows ?? [])
        .filter(
          (row) =>
            row.startTime.getTime() >= now.getTime() &&
            row.officials.some((official) => official.refereeId === ownReferee.id),
        )
        .slice(0, 6)
    : []

  const awaitingAnswer = ownReferee
    ? ownAssignments.filter((row) =>
        row.officials.some(
          (official) => official.refereeId === ownReferee.id && official.status === 'pending',
        ),
      ).length
    : 0

  const unstaffed = canAssign
    ? (schedule?.rows ?? []).filter(
        (row) =>
          row.startTime.getTime() >= now.getTime() &&
          row.status !== 'cancelled' &&
          row.officials.filter((official) => official.status !== 'declined').length === 0,
      ).length
    : 0

  const setupDone =
    counts.leagues > 0 && counts.teams >= 2 && counts.fields > 0 && counts.slots > 0

  return (
    <>
      <PageHeader
        title={orgName}
        subtitle={`Signed in as ${actor.email} · ${org.timezone}`}
        action={<RoleBadge role={role} />}
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

      {canReadDrafts && season && !season.publishedVersion && season._count.games > 0 && (
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

      {awaitingAnswer > 0 && (
        <div className="mb-6">
          <Alert kind="info">
            {awaitingAnswer} assignment{awaitingAnswer === 1 ? '' : 's'} waiting on your answer.
            Open a game below to accept or decline.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        {can(role, 'structure:read') && (
          <Stat label="Teams" value={counts.teams} href={`/app/${orgSlug}/leagues`} hrefLabel="Leagues" />
        )}
        {can(role, 'venue:read') && (
          <Stat label="Fields" value={counts.fields} href={`/app/${orgSlug}/venues`} hrefLabel="Venues" />
        )}
        {!canAssign && !can(role, 'structure:read') && (
          <Card>
            <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
              Your role
            </div>
            <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">{ROLE_DESCRIPTIONS[role]}</p>
          </Card>
        )}
      </div>

      {ownTeamGames.length > 0 && (
        <div className="mt-6">
          <GameList
            title="Your team's next games"
            subtitle="Teams you are staff of."
            rows={ownTeamGames}
            orgSlug={orgSlug}
          />
        </div>
      )}

      {ownReferee && (
        <div className="mt-6">
          <GameList
            title="Your next assignments"
            subtitle={`As ${ownReferee.person.name}. Open a game to accept or decline.`}
            rows={ownAssignments}
            orgSlug={orgSlug}
            emptyLabel="Nothing assigned to you yet."
          />
        </div>
      )}

      {!ownReferee && ownTeamGames.length === 0 && (
        <div className="mt-6">
          <GameList
            title="Next up"
            subtitle={
              season
                ? `${season.league.name} · ${season.name}`
                : 'No seasons yet.'
            }
            rows={upcoming}
            orgSlug={orgSlug}
            emptyLabel={
              schedule?.source === 'none'
                ? 'Nothing has been published for this season yet.'
                : 'No upcoming games.'
            }
          />
        </div>
      )}

      {can(role, 'structure:read') && seasons.length > 0 && (
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

function GameList({
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
  emptyLabel?: string
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">{subtitle}</p>
      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState>{emptyLabel ?? 'Nothing scheduled.'}</EmptyState>
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
