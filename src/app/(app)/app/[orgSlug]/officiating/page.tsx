import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { refereeForUser } from '@/lib/scope'
import { loadRefereeBoard, type OfficiatingAssignment, type OpenGame } from '@/lib/officiating'
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure, RemoveButton } from '@/components/crud-forms'
import { RequestToOfficiate, RespondButtons, WithdrawRequest } from '@/components/officiating'
import {
  DAY_NAMES,
  formatCalendarDate,
  formatInstantInZone,
  formatTimeOfDay,
} from '@/lib/time'

/**
 * A referee's own page: the four states of their assignments, the games going
 * spare, and the availability that governs both.
 *
 * Availability lives here rather than only on the person record because a referee
 * does not hold `roster:read` and so cannot open `/people/[personId]` at all. Until
 * now they held `official:availability:write:own` with no page to exercise it on,
 * which is a permission that might as well not exist.
 */
export default async function OfficiatingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ seasonId?: string }>
}) {
  const { orgSlug } = await params
  const { seasonId: requestedSeasonId } = await searchParams
  const { role, orgId, actor } = await requireOrgAccess(orgSlug, 'org:read')

  const referee = await refereeForUser(actor.userId, orgId)

  // Anyone may reach this URL; only a registered official has anything on it. An
  // admin who is not also a referee lands here and is told so plainly rather than
  // getting a 404 that reads like a broken link.
  if (!referee) {
    return (
      <>
        <PageHeader
          title="Officiating"
          subtitle="Your assignments, and games that need an official."
        />
        <EmptyState>
          You are not registered as an official in this organization, so there is nothing here
          yet. An admin can add you from the People page.
        </EmptyState>
      </>
    )
  }

  const seasons = await prisma.season.findMany({
    where: { deletedAt: null, league: { orgId, deletedAt: null }, status: { not: 'archived' } },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    include: { league: { select: { name: true } } },
  })

  const season =
    seasons.find((candidate) => candidate.id === requestedSeasonId) ??
    seasons.find((candidate) => candidate.status === 'active') ??
    seasons[0] ??
    null

  if (!season) {
    return (
      <>
        <PageHeader title="Officiating" subtitle={referee.person.name} />
        <EmptyState>No seasons have been set up yet.</EmptyState>
      </>
    )
  }

  const board = await loadRefereeBoard({
    orgId,
    seasonId: season.id,
    refereeId: referee.id,
    canReadDrafts: can(role, 'schedule:read'),
  })

  const availability = await prisma.refereeAvailability.findMany({
    where: { refereeId: referee.id, deletedAt: null },
    orderBy: [{ kind: 'asc' }, { dayOfWeek: 'asc' }, { effectiveFrom: 'asc' }],
  })

  const canSetAvailability =
    can(role, 'official:availability:write') || can(role, 'official:availability:write:own')
  const canRequest = can(role, 'official:request:own')
  const requestable = board.openGames.filter((entry) => entry.conflicts.length === 0)

  return (
    <>
      <PageHeader
        title="Officiating"
        subtitle={`${referee.person.name} · ${season.league.name} · ${season.name}`}
        action={
          seasons.length > 1 ? (
            <div className="flex flex-wrap gap-2 text-sm">
              {seasons.map((candidate) => (
                <Link
                  key={candidate.id}
                  href={`/app/${orgSlug}/officiating?seasonId=${candidate.id}`}
                  className={
                    candidate.id === season.id
                      ? 'rounded-full bg-gold px-3 py-1 text-ink-900'
                      : 'rounded-full border border-ink-300 px-3 py-1 text-ink-600 hover:border-turf-500 dark:border-ink-600 dark:text-ink-300'
                  }
                >
                  {/* League as well as season: two leagues run a season of the same
                      name, so "Fall 2026" twice is not a choice anyone can make. */}
                  {candidate.league.name} · {candidate.name}
                </Link>
              ))}
            </div>
          ) : null
        }
      />

      {board.source === 'none' && (
        <div className="mb-6">
          <Alert kind="info">
            Nothing has been published for this season yet, so there is no schedule to show. You
            will see your games here as soon as it goes live.
          </Alert>
        </div>
      )}

      {board.awaitingAnswer.length > 0 && (
        <div className="mb-6">
          <Alert>
            {board.awaitingAnswer.length} game{board.awaitingAnswer.length === 1 ? '' : 's'} waiting
            on your answer. Accept or decline below — until you do, the assigner does not know
            whether the game is covered.
          </Alert>
        </div>
      )}

      {/* Two across even on the narrowest phone: four full-width cards push the
          actual games off the bottom of the screen. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Confirmed" value={board.accepted.length} tone="ok" />
        <Stat
          label="Waiting on you"
          value={board.awaitingAnswer.length}
          tone={board.awaitingAnswer.length > 0 ? 'warn' : 'ok'}
        />
        <Stat label="You asked for" value={board.pendingRequests.length} tone="muted" />
        <Stat label="Available to take" value={requestable.length} tone="muted" />
      </div>

      {/* Ordered by what needs doing: their answer first, then what they have,
          then what they asked for, then what is going spare. */}
      <Section
        title="Waiting on your answer"
        subtitle="Offered to you. The assigner is waiting."
        empty="Nothing is waiting on you."
      >
        {board.awaitingAnswer.map((entry) => (
          <AssignmentRow
            key={entry.assignmentId}
            entry={entry}
            orgId={orgId}
            orgSlug={orgSlug}
            showRespond
          />
        ))}
      </Section>

      <Section
        title="Confirmed"
        subtitle="You accepted these. Turn up."
        empty="You have not accepted any games yet."
      >
        {board.accepted.map((entry) => (
          <AssignmentRow
            key={entry.assignmentId}
            entry={entry}
            orgId={orgId}
            orgSlug={orgSlug}
            showRespond
          />
        ))}
      </Section>

      {board.pendingRequests.length > 0 && (
        <Section
          title="You asked for these"
          subtitle="Waiting on an assigner to answer."
          empty="No outstanding requests."
        >
          {board.pendingRequests.map((entry) => (
            <li
              key={entry.requestId}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span className="text-sm">
                {entry.row ? (
                  <>
                    <Link
                      href={`/app/${orgSlug}/games/${entry.row.id}`}
                      className="font-medium text-turf-600 hover:underline"
                    >
                      {entry.row.homeTeamName} v {entry.row.awayTeamName}
                    </Link>
                    <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                      {entry.position} · {formatInstantInZone(entry.row.startTime, entry.row.timezone)}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-500">A game no longer in the published schedule</span>
                )}
                {entry.note && (
                  <span className="ml-2 text-xs italic text-ink-500 dark:text-ink-400">
                    “{entry.note}”
                  </span>
                )}
              </span>
              <WithdrawRequest orgId={orgId} requestId={entry.requestId} />
            </li>
          ))}
        </Section>
      )}

      {board.declined.length > 0 && (
        <Section
          title="You declined"
          subtitle="Kept here in case you turned one down by mistake — you can still take it back."
          empty=""
        >
          {board.declined.map((entry) => (
            <AssignmentRow
              key={entry.assignmentId}
              entry={entry}
              orgId={orgId}
              orgSlug={orgSlug}
              showRespond
            />
          ))}
        </Section>
      )}

      {board.answeredRequests.length > 0 && (
        <Card className="mt-6">
          <h2 className="text-base font-semibold">Answered requests</h2>
          <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
            {board.answeredRequests.map((entry) => (
              <li key={entry.requestId} className="py-2">
                <span
                  className={
                    entry.status === 'approved'
                      ? 'rounded bg-turf-500/15 px-1.5 py-0.5 text-xs text-turf-700 dark:text-turf-500'
                      : 'rounded bg-ink-500/15 px-1.5 py-0.5 text-xs text-ink-600 dark:text-ink-300'
                  }
                >
                  {entry.status}
                </span>{' '}
                {entry.row ? (
                  <>
                    {entry.row.homeTeamName} v {entry.row.awayTeamName}
                    <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                      {formatInstantInZone(entry.row.startTime, entry.row.timezone)}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-500">game no longer scheduled</span>
                )}
                {entry.decisionNote && (
                  <p className="mt-1 text-xs text-ink-600 dark:text-ink-300">
                    {entry.decisionNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Games needing an official</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          {canRequest
            ? 'Ask for any of these and an assigner will confirm. Games you cannot take are listed with the reason.'
            : 'Short of a full crew.'}
        </p>
        {board.openGames.length === 0 ? (
          <div className="mt-4">
            <EmptyState>
              {board.source === 'none'
                ? 'Nothing published yet.'
                : 'Every upcoming game has a crew. Nothing to pick up.'}
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-ink-200 dark:divide-ink-700">
            {board.openGames.map((entry) => (
              <OpenGameRow
                key={entry.row.id}
                entry={entry}
                orgId={orgId}
                orgSlug={orgSlug}
                canRequest={canRequest}
                refereeName={referee.person.name}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Your availability</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Times are in your local zone. The scheduler treats these as hard rules, so a blackout
          keeps you off a game rather than merely discouraging it. Declaring no weekly windows at
          all means “no stated restriction”.
        </p>

        {availability.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500 dark:text-ink-400">
            No windows declared — you are considered available at any time.
          </p>
        ) : (
          <ul className="mt-3 space-y-1 text-sm">
            {availability.map((slot) => (
              <li key={slot.id} className="flex items-center justify-between gap-3">
                <span>
                  {slot.kind === 'weekly' ? (
                    <>
                      <span className="font-medium">{DAY_NAMES[slot.dayOfWeek ?? 0]}s</span>{' '}
                      {formatTimeOfDay(slot.startMinute ?? 0)}–{formatTimeOfDay(slot.endMinute ?? 0)}
                    </>
                  ) : (
                    <>
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                        blackout
                      </span>{' '}
                      {slot.effectiveFrom && formatCalendarDate(slot.effectiveFrom)}
                      {slot.effectiveTo &&
                        slot.effectiveFrom &&
                        slot.effectiveTo.getTime() !== slot.effectiveFrom.getTime() &&
                        ` → ${formatCalendarDate(slot.effectiveTo)}`}
                      {slot.reason && (
                        <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                          {slot.reason}
                        </span>
                      )}
                    </>
                  )}
                </span>
                {canSetAvailability && (
                  <RemoveButton
                    endpoint={`/api/orgs/${orgId}/referees/${referee.id}/availability/${slot.id}`}
                    label="×"
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {canSetAvailability && (
          <div className="mt-4 space-y-3">
            <Disclosure summary="+ When I can referee">
              <CreateForm
                endpoint={`/api/orgs/${orgId}/referees/${referee.id}/availability`}
                submitLabel="Add window"
                fixed={{ kind: 'weekly' }}
                fields={[
                  {
                    name: 'dayOfWeek',
                    label: 'Day',
                    type: 'select',
                    required: true,
                    numeric: true,
                    defaultValue: '6',
                    options: DAY_NAMES.map((day, index) => ({ value: String(index), label: day })),
                  },
                  { name: 'startTime', label: 'From', type: 'time', required: true, defaultValue: '08:00' },
                  { name: 'endTime', label: 'To', type: 'time', required: true, defaultValue: '14:00' },
                ]}
              />
            </Disclosure>
            <Disclosure summary="+ Dates I am away">
              <CreateForm
                endpoint={`/api/orgs/${orgId}/referees/${referee.id}/availability`}
                submitLabel="Add blackout"
                fixed={{ kind: 'blackout' }}
                fields={[
                  { name: 'startDate', label: 'From', type: 'date', required: true },
                  { name: 'endDate', label: 'To', type: 'date', required: true },
                  { name: 'reason', label: 'Reason' },
                ]}
              />
            </Disclosure>
          </div>
        )}
      </Card>
    </>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'ok' | 'warn' | 'muted'
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

function Section({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string
  subtitle: string
  empty: string
  children: React.ReactNode
}) {
  const rows = Array.isArray(children) ? children : [children]
  const hasRows = rows.flat().filter(Boolean).length > 0

  return (
    <Card className="mt-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">{subtitle}</p>
      {hasRows ? (
        <ul className="mt-3 divide-y divide-ink-200 dark:divide-ink-700">{children}</ul>
      ) : (
        empty && (
          <div className="mt-4">
            <EmptyState>{empty}</EmptyState>
          </div>
        )
      )}
    </Card>
  )
}

function AssignmentRow({
  entry,
  orgId,
  orgSlug,
  showRespond,
}: {
  entry: OfficiatingAssignment
  orgId: string
  orgSlug: string
  showRespond: boolean
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="text-sm">
        <Link
          href={`/app/${orgSlug}/games/${entry.row.id}`}
          className="font-medium text-turf-600 hover:underline"
        >
          {entry.row.homeTeamName} v {entry.row.awayTeamName}
        </Link>
        <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
          {/* Kickoff in the venue's zone, never UTC — the referee is driving there. */}
          {formatInstantInZone(entry.row.startTime, entry.row.timezone)}
          {entry.row.venueName && ` · ${entry.row.venueName} · ${entry.row.fieldName}`}
          {' · you are '}
          <span className="font-medium">{entry.position}</span>
        </div>
      </div>
      {showRespond && (
        <RespondButtons
          orgId={orgId}
          gameId={entry.row.id}
          assignmentId={entry.assignmentId}
          status={entry.status}
        />
      )}
    </li>
  )
}

function OpenGameRow({
  entry,
  orgId,
  orgSlug,
  canRequest,
  refereeName,
}: {
  entry: OpenGame
  orgId: string
  orgSlug: string
  canRequest: boolean
  refereeName: string
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="text-sm">
        <Link
          href={`/app/${orgSlug}/games/${entry.row.id}`}
          className="font-medium text-turf-600 hover:underline"
        >
          {entry.row.homeTeamName} v {entry.row.awayTeamName}
        </Link>
        <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
          {formatInstantInZone(entry.row.startTime, entry.row.timezone)}
          {entry.row.venueName && ` · ${entry.row.venueName} · ${entry.row.fieldName}`}
          {' · needs '}
          <span className="font-medium">{entry.openPositions.join(', ')}</span>
        </div>
      </div>
      {canRequest && (
        <RequestToOfficiate
          orgId={orgId}
          gameId={entry.row.id}
          openPositions={entry.openPositions}
          conflicts={entry.conflicts}
          refereeName={refereeName}
        />
      )}
    </li>
  )
}
