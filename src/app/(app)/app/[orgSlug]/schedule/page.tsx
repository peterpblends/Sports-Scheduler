import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, EmptyState, PageHeader, RoleBadge } from '@/components/ui'
import {
  ScheduleCalendar,
  ScheduleGrouped,
  ScheduleList,
  isScheduleView,
  type ScheduleView,
} from '@/components/schedule-views'
import { ScheduleEditor } from '@/components/schedule-editor'
import { readSchedule } from '@/lib/schedule/read'
import { buildScheduleGrid } from '@/lib/schedule/grid'
import { refereeForUser } from '@/lib/scope'

const VIEW_LABELS: Record<ScheduleView, string> = {
  list: 'List',
  calendar: 'Calendar',
  team: 'By team',
  venue: 'By venue',
  referee: 'By official',
}

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{
    seasonId?: string
    divisionId?: string
    teamId?: string
    venueId?: string
    refereeId?: string
    view?: string
    edit?: string
  }>
}) {
  const { orgSlug } = await params
  const query = await searchParams
  const { role, orgId, actor } = await requireOrgAccess(orgSlug, 'schedule:read:published')

  const canEdit = can(role, 'schedule:edit')
  // The same split the API enforces: privileged roles see the live working set,
  // everyone else sees the published snapshot and nothing before it is published.
  const canReadDrafts = can(role, 'schedule:read')
  const view: ScheduleView = isScheduleView(query.view) ? query.view : 'list'
  const editing = query.edit === '1' && canEdit

  const seasons = await prisma.season.findMany({
    where: { deletedAt: null, league: { orgId, deletedAt: null } },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    include: { league: { select: { name: true } } },
  })

  const activeSeason = query.seasonId
    ? seasons.find((season) => season.id === query.seasonId)
    : (seasons.find((season) => season.status === 'active') ?? seasons[0])

  if (seasons.length === 0 || !activeSeason) {
    return (
      <>
        <PageHeader title="Schedule" subtitle="No seasons yet." action={<RoleBadge role={role} />} />
        <EmptyState>
          Start with the{' '}
          <Link href={`/app/${orgSlug}/setup`} className="text-turf-600 hover:underline">
            setup wizard
          </Link>
          , or add a league on the{' '}
          <Link href={`/app/${orgSlug}/leagues`} className="text-turf-600 hover:underline">
            leagues page
          </Link>
          .
        </EmptyState>
      </>
    )
  }

  const [divisions, venues, referees] = await Promise.all([
    prisma.division.findMany({
      where: { seasonId: activeSeason.id, deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        teams: { where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } },
      },
    }),
    prisma.venue.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.referee.findMany({
      where: { deletedAt: null, person: { orgId, deletedAt: null } },
      orderBy: { person: { name: 'asc' } },
      select: { id: true, person: { select: { name: true } } },
    }),
  ])

  // A referee lands on their own assignments rather than the whole league — it is the
  // only part of the schedule that concerns them, and it is what their role is for.
  const ownReferee = role === 'referee' ? await refereeForUser(actor.userId, orgId) : null
  const refereeFilter =
    query.refereeId ?? (role === 'referee' && view === 'referee' ? ownReferee?.id : undefined)

  const schedule = await readSchedule({
    orgId,
    seasonId: activeSeason.id,
    canReadDrafts,
    filter: {
      divisionId: query.divisionId ?? null,
      teamId: query.teamId ?? null,
      venueId: query.venueId ?? null,
      refereeId: refereeFilter ?? null,
    },
  })

  const fields = await prisma.field.findMany({
    where: { deletedAt: null, venue: { orgId, deletedAt: null } },
    orderBy: [{ venue: { name: 'asc' } }, { name: 'asc' }],
    include: {
      venue: { select: { id: true, name: true, timezone: true } },
      timeSlots: { where: { deletedAt: null } },
    },
  })

  const columns = fields.map((field) => ({
    id: field.id,
    label: field.name,
    venueName: field.venue.name,
  }))

  const filtered =
    schedule.rows.length !== schedule.totalBeforeFilter
      ? `${schedule.rows.length} of ${schedule.totalBeforeFilter} games`
      : `${schedule.rows.length} game${schedule.rows.length === 1 ? '' : 's'}`

  const linkTo = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    const merged = {
      seasonId: activeSeason.id,
      divisionId: query.divisionId,
      teamId: query.teamId,
      venueId: query.venueId,
      refereeId: query.refereeId,
      view: query.view,
      edit: query.edit,
      ...patch,
    }
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value)
    return `/app/${orgSlug}/schedule?${next}`
  }

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle={`${activeSeason.league.name} · ${activeSeason.name} · ${filtered}`}
        action={<RoleBadge role={role} />}
      />

      <div className="mb-6">
        <PublishBanner
          canReadDrafts={canReadDrafts}
          version={schedule.version}
          source={schedule.source}
          versionsHref={`/app/${orgSlug}/seasons/${activeSeason.id}/versions`}
        />
      </div>

      <Card className="mb-6">
        <form className="flex flex-wrap items-end gap-3" action={`/app/${orgSlug}/schedule`}>
          <input type="hidden" name="view" value={view} />
          {editing && <input type="hidden" name="edit" value="1" />}
          <Select name="seasonId" label="Season" value={activeSeason.id}>
            {seasons.map((season) => (
              <option key={season.id} value={season.id}>
                {season.league.name} · {season.name} ({season.status})
              </option>
            ))}
          </Select>
          <Select name="divisionId" label="Division" value={query.divisionId ?? ''} anyLabel="All divisions">
            {divisions.map((division) => (
              <option key={division.id} value={division.id}>
                {division.name}
              </option>
            ))}
          </Select>
          <Select name="teamId" label="Team" value={query.teamId ?? ''} anyLabel="All teams">
            {divisions.flatMap((division) =>
              division.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {division.name} · {team.name}
                </option>
              )),
            )}
          </Select>
          <Select name="venueId" label="Venue" value={query.venueId ?? ''} anyLabel="All venues">
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name}
              </option>
            ))}
          </Select>
          {can(role, 'official:read') && (
            <Select name="refereeId" label="Official" value={query.refereeId ?? ''} anyLabel="All officials">
              {referees.map((referee) => (
                <option key={referee.id} value={referee.id}>
                  {referee.person.name}
                </option>
              ))}
            </Select>
          )}
          <button
            type="submit"
            className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium dark:border-ink-600 dark:bg-ink-800"
          >
            Apply
          </button>
        </form>
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Schedule view">
          {(Object.keys(VIEW_LABELS) as ScheduleView[])
            .filter((candidate) => candidate !== 'referee' || can(role, 'official:read') || role === 'referee')
            .map((candidate) => (
              <Link
                key={candidate}
                href={linkTo({ view: candidate, edit: undefined })}
                aria-current={view === candidate ? 'page' : undefined}
                className={
                  view === candidate
                    ? 'rounded-lg bg-turf-600 px-3 py-1.5 text-sm font-medium text-white'
                    : 'rounded-lg border border-ink-300 px-3 py-1.5 text-sm dark:border-ink-600'
                }
              >
                {VIEW_LABELS[candidate]}
              </Link>
            ))}
        </nav>

        {canEdit && (
          <Link
            href={linkTo({ edit: editing ? undefined : '1', view: 'calendar' })}
            className={
              editing
                ? 'rounded-lg border border-ink-300 px-3 py-1.5 text-sm dark:border-ink-600'
                : 'rounded-lg bg-turf-600 px-3 py-1.5 text-sm font-medium text-white'
            }
          >
            {editing ? 'Done editing' : 'Rearrange games'}
          </Link>
        )}
      </div>

      {editing ? (
        <ScheduleEditor
          orgId={orgId}
          grid={buildScheduleGrid({
            rows: schedule.rows,
            fields: fields.map((field) => ({
              id: field.id,
              name: field.name,
              venueId: field.venue.id,
              venueName: field.venue.name,
              timezone: field.venue.timezone,
              timeSlots: field.timeSlots,
            })),
          })}
        />
      ) : schedule.rows.length === 0 ? (
        <EmptyState>
          {schedule.source === 'none'
            ? 'Nothing has been published for this season yet.'
            : schedule.totalBeforeFilter === 0
              ? 'No games yet. Generate a schedule from the season page.'
              : 'No games match these filters.'}
        </EmptyState>
      ) : view === 'calendar' ? (
        <ScheduleCalendar rows={schedule.rows} orgSlug={orgSlug} columns={columns} />
      ) : view === 'team' ? (
        <ScheduleGrouped
          rows={schedule.rows}
          orgSlug={orgSlug}
          emptyLabel="No games for any team in this filter."
          keysOf={(row) => [
            { id: row.homeTeamId, label: row.homeTeamName, sublabel: row.divisionName },
            { id: row.awayTeamId, label: row.awayTeamName, sublabel: row.divisionName },
          ]}
        />
      ) : view === 'venue' ? (
        <ScheduleGrouped
          rows={schedule.rows}
          orgSlug={orgSlug}
          emptyLabel="No placed games in this filter."
          keysOf={(row) =>
            row.venueId
              ? [{ id: row.venueId, label: row.venueName ?? 'Venue', sublabel: row.timezone }]
              : [{ id: 'unplaced', label: 'Not placed', sublabel: 'no field yet' }]
          }
        />
      ) : view === 'referee' ? (
        <ScheduleGrouped
          rows={schedule.rows}
          orgSlug={orgSlug}
          emptyLabel="No assignments in this filter."
          keysOf={(row) =>
            row.officials.map((official) => ({
              id: official.refereeId,
              label: official.refereeName,
              sublabel: official.position,
            }))
          }
        />
      ) : (
        <ScheduleList rows={schedule.rows} orgSlug={orgSlug} highlightTeamId={query.teamId} />
      )}

      {!canEdit && (
        <div className="mt-6">
          <Alert kind="info">Your role can read the schedule but not change it.</Alert>
        </div>
      )}
    </>
  )
}

function Select({
  name,
  label,
  value,
  anyLabel,
  children,
}: {
  name: string
  label: string
  value: string
  anyLabel?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={value}
        className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
      >
        {anyLabel && <option value="">{anyLabel}</option>}
        {children}
      </select>
    </div>
  )
}

function PublishBanner({
  canReadDrafts,
  version,
  source,
  versionsHref,
}: {
  canReadDrafts: boolean
  version: { number: number; label: string; publishedAt: Date | null } | null
  source: 'live' | 'published' | 'none'
  versionsHref: string
}) {
  if (canReadDrafts) {
    return version ? (
      <Alert kind="info">
        You are looking at the <strong>working draft</strong>. Coaches, referees and viewers see{' '}
        <strong>v{version.number}</strong> ({version.label}).{' '}
        <Link href={versionsHref} className="underline">
          Version history
        </Link>
      </Alert>
    ) : (
      <Alert>
        You are looking at the <strong>working draft</strong>, and nothing is published — so
        coaches, referees and viewers see no schedule at all.{' '}
        <Link href={versionsHref} className="underline">
          Publish a version
        </Link>
      </Alert>
    )
  }

  if (source === 'published' && version) {
    return (
      <Alert kind="success">
        Published schedule, v{version.number}
        {version.publishedAt && ` — published ${new Date(version.publishedAt).toLocaleDateString()}`}.
      </Alert>
    )
  }
  return <Alert kind="info">No schedule has been published for this season yet.</Alert>
}
