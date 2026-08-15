import Link from 'next/link'
import { Alert, Card, EmptyState } from './ui'
import type { CoachDashboard, ViewerDashboard } from '@/lib/dashboard'
import type { RefereeBoard } from '@/lib/officiating'
import type { ScheduleRow } from '@/lib/schedule/read'
import { formatInstantInZone } from '@/lib/time'

/**
 * Role-shaped dashboards.
 *
 * Each of these leads with the one thing that role opens the app to find out, and
 * every kickoff on them is rendered in the venue's zone rather than UTC — these are
 * the pages people read on a phone on the way to a pitch.
 */

/** The hero panel: one game, stated plainly enough to act on. */
function NextGame({
  row,
  orgSlug,
  label,
  highlightTeamIds,
}: {
  row: ScheduleRow
  orgSlug: string
  label: string
  highlightTeamIds?: Set<string>
}) {
  const home = highlightTeamIds?.has(row.homeTeamId) ?? false
  const away = highlightTeamIds?.has(row.awayTeamId) ?? false
  const side = home ? 'Home' : away ? 'Away' : null

  return (
    <Card className="border-turf-500/40 bg-turf-500/[0.03]">
      <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">{label}</div>
      <Link
        href={`/app/${orgSlug}/games/${row.id}`}
        className="mt-1 block text-xl font-semibold hover:text-turf-600"
      >
        {row.homeTeamName} v {row.awayTeamName}
      </Link>
      <div className="mt-2 space-y-0.5 text-sm text-ink-600 dark:text-ink-300">
        <div className="font-medium tabular-nums">
          {formatInstantInZone(row.startTime, row.timezone)}
        </div>
        <div>
          {row.venueName ? `${row.venueName} · ${row.fieldName}` : 'Venue to be confirmed'}
          {side && <span className="ml-2 text-xs uppercase tracking-wide">{side}</span>}
        </div>
        <div className="text-xs text-ink-500 dark:text-ink-400">
          {row.divisionName}
          {row.officials.length > 0 &&
            ` · ${row.officials.map((official) => `${official.position} ${official.refereeName}`).join(', ')}`}
        </div>
      </div>
    </Card>
  )
}

function GameList({
  title,
  subtitle,
  rows,
  orgSlug,
  emptyLabel,
  showScores = false,
  highlightTeamIds,
}: {
  title: string
  subtitle?: string
  rows: ScheduleRow[]
  orgSlug: string
  emptyLabel: string
  showScores?: boolean
  highlightTeamIds?: Set<string>
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">{subtitle}</p>}
      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState>{emptyLabel}</EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
          {rows.map((row) => {
            const mineHome = highlightTeamIds?.has(row.homeTeamId) ?? false
            const mineAway = highlightTeamIds?.has(row.awayTeamId) ?? false
            return (
              <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>
                  <Link
                    href={`/app/${orgSlug}/games/${row.id}`}
                    className="font-medium text-turf-600 hover:underline"
                  >
                    <span className={mineHome ? 'font-semibold' : undefined}>{row.homeTeamName}</span>
                    {' v '}
                    <span className={mineAway ? 'font-semibold' : undefined}>{row.awayTeamName}</span>
                  </Link>
                  {showScores && row.homeScore !== null && row.awayScore !== null && (
                    <span className="ml-2 font-semibold tabular-nums">
                      {row.homeScore}–{row.awayScore}
                    </span>
                  )}
                  <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                    {row.venueName ? `${row.venueName} · ${row.fieldName}` : row.divisionName}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-ink-600 dark:text-ink-300">
                  {formatInstantInZone(row.startTime, row.timezone)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

export function CoachDashboardView({
  data,
  orgSlug,
}: {
  data: CoachDashboard
  orgSlug: string
}) {
  const teamIds = new Set(data.teams.map((team) => team.id))

  if (data.teams.length === 0) {
    return (
      <EmptyState>
        You are not listed as staff on any team yet, so there is nothing to show. An admin can add
        you to a team from its roster page — until then the schedule below is all you can see.
      </EmptyState>
    )
  }

  return (
    <div className="space-y-6">
      {data.source === 'none' && (
        <Alert kind="info">
          No schedule has been published for this season yet. Your fixtures will appear here as soon
          as one is.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {data.next ? (
            <NextGame
              row={data.next}
              orgSlug={orgSlug}
              label="Your next game"
              highlightTeamIds={teamIds}
            />
          ) : (
            <Card>
              <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                Your next game
              </div>
              <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">
                Nothing scheduled ahead of you right now.
              </p>
            </Card>
          )}
        </div>

        <Card>
          <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
            {data.teams.length === 1 ? 'Your team' : 'Your teams'}
          </div>
          <ul className="mt-2 space-y-2 text-sm">
            {data.form.map((entry) => (
              <li key={entry.teamId}>
                <Link
                  href={`/app/${orgSlug}/teams/${entry.teamId}`}
                  className="font-medium text-turf-600 hover:underline"
                >
                  {entry.teamName}
                </Link>
                <div className="text-xs text-ink-500 dark:text-ink-400">
                  {entry.divisionName} · {entry.rosterSize} player
                  {entry.rosterSize === 1 ? '' : 's'}
                </div>
                {entry.played > 0 && (
                  <div className="mt-0.5 text-xs tabular-nums text-ink-600 dark:text-ink-300">
                    {entry.won}W {entry.drawn}D {entry.lost}L · {entry.goalsFor}–
                    {entry.goalsAgainst}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
            You can edit your own roster from your team page. Everything else is read-only.
          </p>
        </Card>
      </div>

      <GameList
        title="Your fixtures"
        subtitle="Every upcoming game for the teams you are staff of. Your team is in bold."
        rows={data.upcoming}
        orgSlug={orgSlug}
        emptyLabel="No upcoming fixtures."
        highlightTeamIds={teamIds}
      />

      {data.recent.length > 0 && (
        <GameList
          title="Recent results"
          rows={data.recent}
          orgSlug={orgSlug}
          emptyLabel="Nothing played yet."
          showScores
          highlightTeamIds={teamIds}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Referee
// ---------------------------------------------------------------------------

export function RefereeDashboardView({
  board,
  orgSlug,
  refereeName,
}: {
  board: RefereeBoard | null
  orgSlug: string
  refereeName: string | null
}) {
  if (!board) {
    return (
      <EmptyState>
        {refereeName
          ? 'No seasons have been set up yet, so there is nothing to officiate.'
          : 'You are not registered as an official in this organization yet. An admin can add you from the People page.'}
      </EmptyState>
    )
  }

  const requestable = board.openGames.filter((entry) => entry.conflicts.length === 0)
  const next = board.accepted[0]?.row ?? board.awaitingAnswer[0]?.row ?? null

  return (
    <div className="space-y-6">
      {board.awaitingAnswer.length > 0 && (
        <Alert>
          {board.awaitingAnswer.length} assignment
          {board.awaitingAnswer.length === 1 ? '' : 's'} waiting on your answer.{' '}
          <Link href={`/app/${orgSlug}/officiating`} className="underline">
            Accept or decline
          </Link>{' '}
          — until you do, nobody knows whether the game is covered.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Confirmed" value={board.accepted.length} href={`/app/${orgSlug}/officiating`} />
        <Stat
          label="Waiting on you"
          value={board.awaitingAnswer.length}
          tone={board.awaitingAnswer.length > 0 ? 'warn' : 'ok'}
          href={`/app/${orgSlug}/officiating`}
        />
        <Stat
          label="You asked for"
          value={board.pendingRequests.length}
          href={`/app/${orgSlug}/officiating`}
        />
        <Stat
          label="Free to pick up"
          value={requestable.length}
          href={`/app/${orgSlug}/officiating`}
        />
      </div>

      {next && <NextGame row={next} orgSlug={orgSlug} label="Your next match" />}

      <GameList
        title="Waiting on your answer"
        subtitle="Somebody is blocked on these."
        rows={board.awaitingAnswer.map((entry) => entry.row)}
        orgSlug={orgSlug}
        emptyLabel="Nothing waiting on you."
      />

      <GameList
        title="Confirmed"
        rows={board.accepted.map((entry) => entry.row)}
        orgSlug={orgSlug}
        emptyLabel="You have not accepted any games yet."
      />

      <Card>
        <h2 className="text-base font-semibold">Games needing an official</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          {requestable.length === 0
            ? 'Nothing you can pick up right now.'
            : `${requestable.length} game${requestable.length === 1 ? '' : 's'} you could take.`}
        </p>
        <Link
          href={`/app/${orgSlug}/officiating`}
          className="mt-2 inline-block text-sm text-turf-600 hover:underline"
        >
          Open my officiating page →
        </Link>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export function ViewerDashboardView({
  data,
  orgSlug,
  publicSlug,
}: {
  data: ViewerDashboard
  orgSlug: string
  publicSlug: string
}) {
  return (
    <div className="space-y-6">
      {data.source === 'none' ? (
        <Alert kind="info">
          Nothing has been published for this season yet. There is no schedule to show until an
          organizer publishes one.
        </Alert>
      ) : (
        data.published && (
          <p className="text-sm text-ink-500 dark:text-ink-300">
            Showing published version {data.published.number}
            {data.published.publishedAt &&
              `, live since ${data.published.publishedAt.toISOString().slice(0, 10)}`}
            . {data.totalGames} game{data.totalGames === 1 ? '' : 's'} in the season.
          </p>
        )
      )}

      {data.next && <NextGame row={data.next} orgSlug={orgSlug} label="Next up" />}

      <GameList
        title="Coming up"
        rows={data.upcoming}
        orgSlug={orgSlug}
        emptyLabel="No upcoming games."
      />

      {data.recent.length > 0 && (
        <GameList
          title="Recent results"
          rows={data.recent}
          orgSlug={orgSlug}
          emptyLabel="Nothing played yet."
          showScores
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {data.divisions.length > 0 && (
          <Card>
            <h2 className="text-base font-semibold">Divisions</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {data.divisions.map((division) => (
                <li key={division.id} className="flex justify-between gap-4">
                  <Link
                    href={`/app/${orgSlug}/schedule?divisionId=${division.id}`}
                    className="text-turf-600 hover:underline"
                  >
                    {division.name}
                  </Link>
                  <span className="tabular-nums text-ink-500 dark:text-ink-400">
                    {division.teamCount} team{division.teamCount === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <h2 className="text-base font-semibold">Keep up with it</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <Link href={`/app/${orgSlug}/subscriptions`} className="text-turf-600 hover:underline">
                Subscribe in your calendar
              </Link>
              <p className="text-xs text-ink-500 dark:text-ink-400">
                A live feed that updates when a game moves, rather than a copy that goes stale.
              </p>
            </li>
            <li>
              <Link href={`/s/${publicSlug}`} className="text-turf-600 hover:underline">
                The public schedule page
              </Link>
              <p className="text-xs text-ink-500 dark:text-ink-400">
                No login needed — the link to send to a parent.
              </p>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  href,
  tone = 'ok',
}: {
  label: string
  value: number
  href?: string
  tone?: 'ok' | 'warn'
}) {
  const body = (
    <>
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
    </>
  )

  return <Card>{href ? <Link href={href}>{body}</Link> : body}</Card>
}
