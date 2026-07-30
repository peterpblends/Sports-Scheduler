import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, EmptyState, PageHeader, RoleBadge } from '@/components/ui'
import { CreateForm, Disclosure } from '@/components/crud-forms'
import { calendarDateInZone, formatCalendarDate, formatClockInZone, formatInstantInZone } from '@/lib/time'
import { readableSnapshot } from '@/lib/versions/service'

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ seasonId?: string; divisionId?: string }>
}) {
  const { orgSlug } = await params
  const { seasonId, divisionId } = await searchParams
  const { role, orgId } = await requireOrgAccess(orgSlug, 'schedule:read:published')
  const editable = can(role, 'schedule:edit')
  // The same split the API enforces: privileged roles see the live working set,
  // everyone else sees the published snapshot and nothing before it is published.
  const canReadDrafts = can(role, 'schedule:read')

  const seasons = await prisma.season.findMany({
    where: { deletedAt: null, league: { orgId, deletedAt: null } },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    include: { league: { select: { name: true } } },
  })

  const activeSeason = seasonId
    ? seasons.find((s) => s.id === seasonId)
    : (seasons.find((s) => s.status === 'active') ?? seasons[0])

  const divisions = activeSeason
    ? await prisma.division.findMany({
        where: { seasonId: activeSeason.id, deletedAt: null },
        orderBy: { name: 'asc' },
        include: {
          teams: { where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } },
        },
      })
    : []

  const publishedVersion = activeSeason
    ? (
        await prisma.season.findUniqueOrThrow({
          where: { id: activeSeason.id },
          select: {
            publishedVersion: { select: { id: true, number: true, label: true, publishedAt: true } },
          },
        })
      ).publishedVersion
    : null

  const liveGames = activeSeason && canReadDrafts
    ? await prisma.game.findMany({
        where: {
          deletedAt: null,
          seasonId: activeSeason.id,
          ...(divisionId ? { divisionId } : {}),
        },
        orderBy: { startTime: 'asc' },
        include: {
          homeTeam: { select: { id: true, name: true } },
          awayTeam: { select: { id: true, name: true } },
          division: { select: { id: true, name: true } },
          field: { include: { venue: { select: { name: true, timezone: true } } } },
          officials: {
            where: { deletedAt: null },
            include: { referee: { include: { person: { select: { name: true } } } } },
          },
        },
      })
    : []

  // A published read comes from the frozen snapshot, so a draft edit cannot leak.
  const published = activeSeason && !canReadDrafts
    ? await readableSnapshot(activeSeason.id, false)
    : null

  const orgTimezone = (await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).timezone

  type Row = {
    id: string
    startTime: Date
    durationMinutes: number
    status: string
    roundNumber: number | null
    homeScore: number | null
    awayScore: number | null
    homeTeam: { name: string }
    awayTeam: { name: string }
    division: { id: string; name: string }
    field: { name: string; venue: { name: string; timezone: string } } | null
    officials: Array<{ id: string; position: string; status: string; refereeName: string }>
  }

  const games: Row[] = canReadDrafts
    ? liveGames.map((game) => ({
        id: game.id,
        startTime: game.startTime,
        durationMinutes: game.durationMinutes,
        status: game.status,
        roundNumber: game.roundNumber,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        division: game.division,
        field: game.field
          ? { name: game.field.name, venue: game.field.venue }
          : null,
        officials: game.officials.map((official) => ({
          id: official.id,
          position: official.position,
          status: official.status,
          refereeName: official.referee.person.name,
        })),
      }))
    : (published?.snapshot?.games ?? [])
        .filter((game) => !divisionId || game.divisionId === divisionId)
        .map((game) => ({
          id: game.gameId,
          startTime: new Date(game.startTime),
          durationMinutes: game.durationMinutes,
          status: game.status,
          roundNumber: game.roundNumber,
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          homeTeam: { name: game.homeTeamName },
          awayTeam: { name: game.awayTeamName },
          division: { id: game.divisionId, name: game.divisionName },
          field:
            game.fieldName && game.venueName && game.timezone
              ? { name: game.fieldName, venue: { name: game.venueName, timezone: game.timezone } }
              : null,
          officials: game.officials.map((official, index) => ({
            id: `${game.gameId}:${index}`,
            position: official.position,
            status: official.status,
            refereeName: official.refereeName,
          })),
        }))

  /**
   * Grouped by the *venue's* local date, not the UTC date. An 8pm Pacific game on
   * a Saturday is already Sunday in UTC; grouping on UTC would file it under the
   * wrong day.
   */
  const byLocalDate = new Map<string, typeof games>()
  for (const game of games) {
    const tz = game.field?.venue.timezone ?? orgTimezone
    const key = formatCalendarDate(calendarDateInZone(game.startTime, tz))
    const bucket = byLocalDate.get(key) ?? []
    bucket.push(game)
    byLocalDate.set(key, bucket)
  }

  const allTeams = divisions.flatMap((d) => d.teams.map((t) => ({ ...t, divisionId: d.id })))
  const fields = await prisma.field.findMany({
    where: { deletedAt: null, venue: { orgId, deletedAt: null } },
    orderBy: [{ venue: { name: 'asc' } }, { name: 'asc' }],
    include: { venue: { select: { name: true } } },
  })

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle={
          activeSeason
            ? `${activeSeason.league.name} · ${activeSeason.name} · ${games.length} game${games.length === 1 ? '' : 's'}`
            : 'No seasons yet.'
        }
        action={<RoleBadge role={role} />}
      />

      {seasons.length === 0 ? (
        <EmptyState>
          Create a league and season first on the{' '}
          <Link href={`/app/${orgSlug}/leagues`} className="text-turf-600 hover:underline">
            leagues page
          </Link>
          .
        </EmptyState>
      ) : (
        <>
          <div className="mb-6">
            {canReadDrafts ? (
              publishedVersion ? (
                <Alert kind="info">
                  You are looking at the <strong>working draft</strong>. Coaches, referees and
                  viewers see <strong>v{publishedVersion.number}</strong> ({publishedVersion.label}).{' '}
                  <Link
                    href={`/app/${orgSlug}/seasons/${activeSeason?.id}/versions`}
                    className="underline"
                  >
                    Version history
                  </Link>
                </Alert>
              ) : (
                <Alert>
                  You are looking at the <strong>working draft</strong>, and nothing is published —
                  so coaches, referees and viewers see no schedule at all.{' '}
                  <Link
                    href={`/app/${orgSlug}/seasons/${activeSeason?.id}/versions`}
                    className="underline"
                  >
                    Publish a version
                  </Link>
                </Alert>
              )
            ) : published?.version ? (
              <Alert kind="success">
                Published schedule, v{published.version.number}
                {published.version.publishedAt &&
                  ` — published ${new Date(published.version.publishedAt).toLocaleDateString()}`}
                .
              </Alert>
            ) : (
              <Alert kind="info">
                No schedule has been published for this season yet.
              </Alert>
            )}
          </div>

          <Card className="mb-6">
            <form className="flex flex-wrap items-end gap-3" action={`/app/${orgSlug}/schedule`}>
              <div>
                <label htmlFor="seasonId" className="mb-1.5 block text-sm font-medium">
                  Season
                </label>
                <select
                  id="seasonId"
                  name="seasonId"
                  defaultValue={activeSeason?.id}
                  className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
                >
                  {seasons.map((season) => (
                    <option key={season.id} value={season.id}>
                      {season.league.name} · {season.name} ({season.status})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="divisionId" className="mb-1.5 block text-sm font-medium">
                  Division
                </label>
                <select
                  id="divisionId"
                  name="divisionId"
                  defaultValue={divisionId ?? ''}
                  className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
                >
                  <option value="">All divisions</option>
                  {divisions.map((division) => (
                    <option key={division.id} value={division.id}>
                      {division.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium dark:border-ink-600 dark:bg-ink-800"
              >
                Apply
              </button>
            </form>
          </Card>

          {games.length === 0 ? (
            <EmptyState>
              No games yet. The phase 3 generator fills a season from a schedule configuration; until
              then you can add games by hand below.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {[...byLocalDate.entries()].map(([localDate, dayGames]) => (
                <Card key={localDate}>
                  <h2 className="text-base font-semibold">
                    {new Date(`${localDate}T00:00:00Z`).toLocaleDateString('en-US', {
                      timeZone: 'UTC',
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                    <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
                      {dayGames.length} game{dayGames.length === 1 ? '' : 's'}
                    </span>
                  </h2>

                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                        <tr>
                          <th className="pb-2 pr-4 font-medium">Local time</th>
                          <th className="pb-2 pr-4 font-medium">Division</th>
                          <th className="pb-2 pr-4 font-medium">Match</th>
                          <th className="pb-2 pr-4 font-medium">Field</th>
                          <th className="pb-2 pr-4 font-medium">Officials</th>
                          <th className="pb-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                        {dayGames.map((game) => {
                          const tz = game.field?.venue.timezone ?? orgTimezone
                          return (
                            <tr key={game.id}>
                              <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                                {formatClockInZone(game.startTime, tz)}
                                <div className="text-xs text-ink-500 dark:text-ink-400">
                                  {game.durationMinutes} min
                                </div>
                              </td>
                              <td className="py-2 pr-4 text-xs text-ink-600 dark:text-ink-300">
                                {game.division.name}
                                {game.roundNumber !== null && (
                                  <div className="text-ink-500 dark:text-ink-400">
                                    round {game.roundNumber}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 pr-4">
                                <Link
                                  href={`/app/${orgSlug}/games/${game.id}`}
                                  className="font-medium text-turf-600 hover:underline"
                                >
                                  {game.homeTeam.name}
                                  <span className="font-normal text-ink-500 dark:text-ink-400"> vs </span>
                                  {game.awayTeam.name}
                                </Link>
                                {game.homeScore !== null && game.awayScore !== null && (
                                  <span className="ml-2 tabular-nums text-ink-600 dark:text-ink-300">
                                    {game.homeScore}–{game.awayScore}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-xs text-ink-600 dark:text-ink-300">
                                {game.field ? (
                                  <>
                                    {game.field.venue.name}
                                    <div className="text-ink-500 dark:text-ink-400">
                                      {game.field.name}
                                    </div>
                                  </>
                                ) : (
                                  <span className="text-amber-700 dark:text-amber-300">unplaced</span>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-xs">
                                {game.officials.length === 0 ? (
                                  <span className="text-amber-700 dark:text-amber-300">unfilled</span>
                                ) : (
                                  game.officials.map((official) => (
                                    <div key={official.id}>
                                      {official.refereeName}
                                      <span className="text-ink-500 dark:text-ink-400">
                                        {' '}
                                        ({official.position}, {official.status})
                                      </span>
                                    </div>
                                  ))
                                )}
                              </td>
                              <td className="py-2 text-xs">
                                <span className="rounded-full bg-ink-100 px-2 py-0.5 dark:bg-ink-900">
                                  {game.status}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
                    Times shown in each venue&apos;s local zone. First game:{' '}
                    {formatInstantInZone(
                      dayGames[0]!.startTime,
                      dayGames[0]!.field?.venue.timezone ?? orgTimezone,
                    )}
                  </p>
                </Card>
              ))}
            </div>
          )}

          {editable && activeSeason && divisions.length > 0 && (
            <Card className="mt-6">
              <h2 className="text-base font-semibold">Add a game by hand</h2>
              <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
                For one-offs outside the generated schedule. Hard constraints are checked on save;
                breaking one needs a reason, which is logged.
              </p>
              <div className="mt-4">
                <Disclosure summary="+ New game">
                  <ManualGameForm
                    orgId={orgId}
                    divisions={divisions.map((d) => ({ id: d.id, name: d.name }))}
                    teams={allTeams}
                    fields={fields.map((f) => ({
                      id: f.id,
                      label: `${f.venue.name} — ${f.name}`,
                    }))}
                  />
                </Disclosure>
              </div>
            </Card>
          )}

          {!editable && (
            <div className="mt-6">
              <Alert kind="info">
                Your role can read the schedule but not change it.
              </Alert>
            </div>
          )}
        </>
      )}
    </>
  )
}

function ManualGameForm({
  orgId,
  divisions,
  teams,
  fields,
}: {
  orgId: string
  divisions: { id: string; name: string }[]
  teams: { id: string; name: string; divisionId: string }[]
  fields: { id: string; label: string }[]
}) {
  return (
    <CreateForm
      endpoint={`/api/orgs/${orgId}/games`}
      submitLabel="Create game"
      fields={[
        {
          name: 'divisionId',
          label: 'Division',
          type: 'select',
          required: true,
          options: divisions.map((d) => ({ value: d.id, label: d.name })),
        },
        {
          name: 'homeTeamId',
          label: 'Home',
          type: 'select',
          required: true,
          options: teams.map((t) => ({ value: t.id, label: t.name })),
        },
        {
          name: 'awayTeamId',
          label: 'Away',
          type: 'select',
          required: true,
          options: teams.map((t) => ({ value: t.id, label: t.name })),
        },
        {
          name: 'fieldId',
          label: 'Field',
          type: 'select',
          options: fields.map((f) => ({ value: f.id, label: f.label })),
        },
        {
          name: 'startTime',
          label: 'Kickoff (UTC, ISO 8601)',
          required: true,
          placeholder: '2026-04-11T16:00:00Z',
          help: 'Stored as UTC; displayed in the venue’s zone.',
        },
        {
          name: 'durationMinutes',
          label: 'Minutes',
          type: 'number',
          numeric: true,
          defaultValue: '60',
        },
        {
          name: 'overrideReason',
          label: 'Override reason',
          help: 'Only needed if the placement breaks a hard constraint.',
        },
      ]}
    />
  )
}
