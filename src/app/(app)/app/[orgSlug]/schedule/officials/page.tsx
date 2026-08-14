import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui'
import { readSchedule, groupByLocalDate } from '@/lib/schedule/read'
import { formatDayHeading } from '@/components/schedule-views'
import { formatClockInZone, formatInstantInZone } from '@/lib/time'
import { can } from '@/lib/authz'
import { pendingRequestsForOrg } from '@/lib/officiating'
import { DecideRequest } from '@/components/officiating'

/**
 * The assignment board: every game short of a full crew, worst first.
 *
 * Deliberately a triage list rather than another schedule view. What an assigner
 * needs is "where are the holes and how urgent are they", so games are ordered by how
 * many positions are missing and then by kickoff, and each row links to the game where
 * the actual picker — with its eligibility and conflict warnings — lives.
 */
export default async function OfficialsBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ seasonId?: string; crew?: string; show?: string }>
}) {
  const { orgSlug } = await params
  const query = await searchParams
  const { orgId, role } = await requireOrgAccess(orgSlug, 'official:assign')

  const seasons = await prisma.season.findMany({
    where: { deletedAt: null, league: { orgId, deletedAt: null } },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    include: { league: { select: { name: true } } },
  })
  const season = query.seasonId
    ? seasons.find((candidate) => candidate.id === query.seasonId)
    : (seasons.find((candidate) => candidate.status === 'active') ?? seasons[0])
  if (!season) {
    return (
      <>
        <PageHeader title="Assignment board" subtitle="No seasons yet." />
        <EmptyState>Create a season before assigning officials.</EmptyState>
      </>
    )
  }

  const crewSize = Math.min(4, Math.max(1, Number(query.crew ?? 3) || 3))
  const showAll = query.show === 'all'

  const schedule = await readSchedule({ orgId, seasonId: season.id, canReadDrafts: true })

  const withCounts = schedule.rows
    // A cancelled game needs nobody.
    .filter((row) => row.status !== 'cancelled' && row.status !== 'postponed')
    .map((row) => {
      const accepted = row.officials.filter((official) => official.status === 'accepted').length
      const declined = row.officials.filter((official) => official.status === 'declined').length
      const pending = row.officials.filter((official) => official.status === 'pending').length
      // A declined assignment is a hole, not a filled slot.
      const holding = row.officials.length - declined
      return { row, missing: Math.max(0, crewSize - holding), accepted, pending, declined }
    })

  const needing = withCounts.filter((entry) => entry.missing > 0 || entry.declined > 0)
  const shown = showAll ? withCounts : needing

  const totals = {
    games: withCounts.length,
    positions: withCounts.length * crewSize,
    filled: withCounts.reduce((sum, entry) => sum + entry.accepted + entry.pending, 0),
    declined: withCounts.reduce((sum, entry) => sum + entry.declined, 0),
    short: needing.length,
  }

  const days = groupByLocalDate(shown.map((entry) => entry.row))
  const byId = new Map(shown.map((entry) => [entry.row.id, entry]))

  // Referees who have volunteered. Shown above the holes rather than below them,
  // because approving a request is the cheapest way to close one.
  const requests = can(role, 'official:request:review') ? await pendingRequestsForOrg(orgId) : []

  const linkTo = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries({
      seasonId: season.id,
      crew: String(crewSize),
      show: query.show,
      ...patch,
    })) {
      if (value) next.set(key, value)
    }
    return `/app/${orgSlug}/schedule/officials?${next}`
  }

  return (
    <>
      <PageHeader
        title="Assignment board"
        subtitle={`${season.league.name} · ${season.name}`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link href={`/app/${orgSlug}/schedule`} className="text-ink-500 hover:underline dark:text-ink-300">
          ← Schedule
        </Link>
        <Link href={linkTo({ show: showAll ? undefined : 'all' })} className="text-turf-600 hover:underline">
          {showAll ? 'Show only games needing officials' : 'Show every game'}
        </Link>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Games" value={totals.games} />
        <Stat label="Positions assigned" value={`${totals.filled} / ${totals.positions}`} />
        <Stat label="Games short" value={totals.short} tone={totals.short > 0 ? 'warn' : 'ok'} />
        <Stat label="Declined" value={totals.declined} tone={totals.declined > 0 ? 'warn' : 'ok'} />
      </div>

      <Card className="mb-6">
        <form className="flex flex-wrap items-end gap-3" action={`/app/${orgSlug}/schedule/officials`}>
          {showAll && <input type="hidden" name="show" value="all" />}
          <div>
            <label htmlFor="seasonId" className="mb-1.5 block text-sm font-medium">
              Season
            </label>
            <select
              id="seasonId"
              name="seasonId"
              defaultValue={season.id}
              className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
            >
              {seasons.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.league.name} · {candidate.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="crew" className="mb-1.5 block text-sm font-medium">
              Crew size
            </label>
            <select
              id="crew"
              name="crew"
              defaultValue={String(crewSize)}
              className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
            >
              {[1, 2, 3, 4].map((size) => (
                <option key={size} value={size}>
                  {size} official{size === 1 ? '' : 's'} per game
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

      {requests.length > 0 && (
        <Card className="mb-6 border-turf-500/40">
          <h2 className="text-base font-semibold">
            {requests.length} referee{requests.length === 1 ? '' : 's'} asking for a game
          </h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            They volunteered, so approving puts them straight on the crew as accepted — no second
            round of confirming. The hard rules are re-checked when you approve, not when they
            asked.
          </p>
          <ul className="mt-3 divide-y divide-ink-200 dark:divide-ink-700">
            {requests.map((request) => {
              const timezone = request.game.field?.venue.timezone ?? 'UTC'
              return (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="text-sm">
                    <span className="font-medium">{request.referee.person.name}</span>
                    <span className="text-ink-500 dark:text-ink-400">
                      {' '}
                      wants {request.position} for{' '}
                    </span>
                    <Link
                      href={`/app/${orgSlug}/games/${request.gameId}`}
                      className="font-medium text-turf-600 hover:underline"
                    >
                      {request.game.homeTeam.name} v {request.game.awayTeam.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
                      {formatInstantInZone(request.game.startTime, timezone)}
                      {request.game.field &&
                        ` · ${request.game.field.venue.name} · ${request.game.field.name}`}
                    </div>
                    {request.note && (
                      <p className="mt-1 text-xs italic text-ink-600 dark:text-ink-300">
                        “{request.note}”
                      </p>
                    )}
                  </div>
                  <DecideRequest
                    orgId={orgId}
                    requestId={request.id}
                    refereeName={request.referee.person.name}
                  />
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {schedule.rows.length === 0 ? (
        <EmptyState>No games in this season yet.</EmptyState>
      ) : shown.length === 0 ? (
        <Alert kind="success">
          Every game has {crewSize} official{crewSize === 1 ? '' : 's'} and nobody has declined.
        </Alert>
      ) : (
        <div className="space-y-4">
          {days.map((day) => (
            <Card key={day.date}>
              <h2 className="text-base font-semibold">{formatDayHeading(day.date)}</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                    <tr>
                      <th className="pb-2 pr-4 font-medium">Time</th>
                      <th className="pb-2 pr-4 font-medium">Match</th>
                      <th className="pb-2 pr-4 font-medium">Where</th>
                      <th className="pb-2 pr-4 font-medium">Crew</th>
                      <th className="pb-2 font-medium">Needs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                    {day.rows.map((row) => {
                      const entry = byId.get(row.id)!
                      return (
                        <tr key={row.id}>
                          <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                            {formatClockInZone(row.startTime, row.timezone)}
                          </td>
                          <td className="py-2 pr-4">
                            <Link
                              href={`/app/${orgSlug}/games/${row.id}`}
                              className="font-medium text-turf-600 hover:underline"
                            >
                              {row.homeTeamName} v {row.awayTeamName}
                            </Link>
                            <div className="text-xs text-ink-500 dark:text-ink-400">
                              {row.divisionName}
                            </div>
                          </td>
                          <td className="py-2 pr-4 text-xs text-ink-600 dark:text-ink-300">
                            {row.venueName ? `${row.venueName} · ${row.fieldName}` : 'unplaced'}
                          </td>
                          <td className="py-2 pr-4 text-xs">
                            {row.officials.length === 0 ? (
                              <span className="text-ink-500 dark:text-ink-400">nobody</span>
                            ) : (
                              row.officials.map((official) => (
                                <div
                                  key={official.id}
                                  className={
                                    official.status === 'declined'
                                      ? 'text-red-700 line-through dark:text-red-300'
                                      : undefined
                                  }
                                >
                                  {official.refereeName}{' '}
                                  <span className="text-ink-500 dark:text-ink-400">
                                    ({official.position})
                                  </span>
                                </div>
                              ))
                            )}
                          </td>
                          <td className="py-2 text-xs">
                            {entry.missing > 0 && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                                {entry.missing} more
                              </span>
                            )}
                            {entry.declined > 0 && (
                              <span className="ml-1 rounded-full bg-red-500/15 px-2 py-0.5 text-red-700 dark:text-red-300">
                                {entry.declined} declined
                              </span>
                            )}
                            {entry.missing === 0 && entry.declined === 0 && (
                              <span className="text-turf-700 dark:text-turf-500">complete</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}

function Stat({
  label,
  value,
  tone = 'ok',
}: {
  label: string
  value: string | number
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
    </Card>
  )
}
