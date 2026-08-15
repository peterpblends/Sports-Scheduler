import Link from 'next/link'
import clsx from 'clsx'
import { Card, EmptyState } from './ui'
import { formatClockInZone } from '@/lib/time'
import type { ScheduleRow } from '@/lib/schedule/read'
import { groupByLocalDate } from '@/lib/schedule/read'

/**
 * The read-only schedule presentations: a day-grouped list, and a grid keyed by
 * date and field. Both are server components — nothing here needs interactivity,
 * which keeps the common case free of client JavaScript. The drag-and-drop grid is
 * a separate client component that reuses the same row shape.
 */

export const VIEWS = ['list', 'calendar', 'team', 'venue', 'referee'] as const
export type ScheduleView = (typeof VIEWS)[number]

export function isScheduleView(value: string | undefined): value is ScheduleView {
  return !!value && (VIEWS as readonly string[]).includes(value)
}

/** Renders the long date heading a day group carries, in the venue's terms. */
export function formatDayHeading(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={clsx('inline-flex rounded-full px-2 py-0.5 text-xs whitespace-nowrap', {
        'bg-ink-100 text-ink-600 dark:bg-ink-900 dark:text-ink-300': status === 'scheduled',
        'bg-turf-500/15 text-turf-700 dark:text-turf-500': status === 'confirmed' || status === 'played',
        'bg-amber-500/15 text-amber-700 dark:text-amber-300': status === 'postponed',
        'bg-red-500/15 text-red-700 dark:text-red-300': status === 'cancelled' || status === 'forfeited',
      })}
    >
      {status}
    </span>
  )
}

function OfficialList({ officials }: { officials: ScheduleRow['officials'] }) {
  if (officials.length === 0) {
    return <span className="text-amber-700 dark:text-amber-300">unfilled</span>
  }
  return (
    <>
      {officials.map((official) => (
        <div key={official.id} className="whitespace-nowrap">
          {official.refereeName}
          <span className="text-ink-500 dark:text-ink-400">
            {' '}
            ({official.position}
            {official.status !== 'pending' && `, ${official.status}`})
          </span>
        </div>
      ))}
    </>
  )
}

/** A game's match-up, linked to its detail page when the reader can open one. */
function Match({
  row,
  orgSlug,
  linkGames,
  highlightTeamId,
}: {
  row: ScheduleRow
  orgSlug: string
  linkGames: boolean
  highlightTeamId?: string | null
}) {
  const label = (
    <>
      <span className={clsx(highlightTeamId === row.homeTeamId && 'font-semibold')}>
        {row.homeTeamName}
      </span>
      <span className="font-normal text-ink-500 dark:text-ink-400"> vs </span>
      <span className={clsx(highlightTeamId === row.awayTeamId && 'font-semibold')}>
        {row.awayTeamName}
      </span>
    </>
  )

  return (
    <>
      {linkGames ? (
        <Link
          href={`/app/${orgSlug}/games/${row.id}`}
          className="font-medium text-turf-600 hover:underline"
        >
          {label}
        </Link>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      {row.homeScore !== null && row.awayScore !== null && (
        <span className="ml-2 tabular-nums text-ink-600 dark:text-ink-300">
          {row.homeScore}–{row.awayScore}
        </span>
      )}
    </>
  )
}

export function ScheduleList({
  rows,
  orgSlug,
  linkGames = true,
  highlightTeamId,
  showOfficials = true,
}: {
  rows: ScheduleRow[]
  orgSlug: string
  linkGames?: boolean
  highlightTeamId?: string | null
  showOfficials?: boolean
}) {
  const days = groupByLocalDate(rows)
  if (days.length === 0) return <EmptyState>No games match this view.</EmptyState>

  return (
    <div className="space-y-4">
      {days.map((day) => (
        <Card key={day.date}>
          <h2 className="text-base font-semibold">
            {formatDayHeading(day.date)}
            <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
              {day.rows.length} game{day.rows.length === 1 ? '' : 's'}
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
                  {showOfficials && <th className="pb-2 pr-4 font-medium">Officials</th>}
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {day.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                      {formatClockInZone(row.startTime, row.timezone)}
                      <div className="text-xs text-ink-500 dark:text-ink-400">
                        {row.durationMinutes} min
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-600 dark:text-ink-300">
                      {row.divisionName}
                      {row.roundNumber !== null && (
                        <div className="text-ink-500 dark:text-ink-400">round {row.roundNumber}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Match
                        row={row}
                        orgSlug={orgSlug}
                        linkGames={linkGames}
                        highlightTeamId={highlightTeamId}
                      />
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-600 dark:text-ink-300">
                      {row.venueName ? (
                        <>
                          {row.venueName}
                          <div className="text-ink-500 dark:text-ink-400">{row.fieldName}</div>
                        </>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">unplaced</span>
                      )}
                    </td>
                    {showOfficials && (
                      <td className="py-2 pr-4 text-xs">
                        <OfficialList officials={row.officials} />
                      </td>
                    )}
                    <td className="py-2 text-xs">
                      <StatusChip status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
            Times in each venue&apos;s own zone
            {day.rows[0] && ` · ${day.rows[0].timezone}`}.
          </p>
        </Card>
      ))}
    </div>
  )
}

/**
 * Date × field grid — the shape a scheduler actually thinks in. One column per
 * field, one block per playing date, so a double-booking or an empty field reads
 * at a glance rather than needing a scan down a list.
 */
export function ScheduleCalendar({
  rows,
  orgSlug,
  columns,
  linkGames = true,
}: {
  rows: ScheduleRow[]
  orgSlug: string
  /** Every field in the org, so an unused field still shows as an empty column. */
  columns: Array<{ id: string; label: string; venueName: string }>
  linkGames?: boolean
}) {
  const days = groupByLocalDate(rows)
  if (days.length === 0) return <EmptyState>No games match this view.</EmptyState>

  // Only the fields this view actually touches, plus nothing — an org with 30 fields
  // should not render 30 empty columns for a single-venue division.
  const used = new Set(rows.map((row) => row.fieldId).filter((id): id is string => !!id))
  const shown = columns.filter((column) => used.has(column.id))
  const hasUnplaced = rows.some((row) => !row.fieldId)

  return (
    <div className="space-y-4">
      {days.map((day) => {
        const byField = new Map<string, ScheduleRow[]>()
        for (const row of day.rows) {
          const key = row.fieldId ?? 'unplaced'
          const bucket = byField.get(key)
          if (bucket) bucket.push(row)
          else byField.set(key, [row])
        }

        // One section per field (plus "not placed"), each pre-sorted by kickoff. Built
        // once and rendered twice below — a side-by-side grid from `sm` up, and a
        // stacked list under it — so a field-by-field view doesn't force horizontal
        // scrolling on a phone the way an N-column grid of 190px cards would.
        const sections = [
          ...shown.map((column) => ({
            key: column.id,
            label: column.label,
            sublabel: column.venueName,
            amber: false,
            rows: (byField.get(column.id) ?? []).sort(
              (a, b) => a.startTime.getTime() - b.startTime.getTime(),
            ),
          })),
          ...(hasUnplaced
            ? [
                {
                  key: 'unplaced',
                  label: 'Not placed',
                  sublabel: 'no field yet',
                  amber: true,
                  rows: byField.get('unplaced') ?? [],
                },
              ]
            : []),
        ]

        return (
          <Card key={day.date}>
            <h2 className="mb-3 text-base font-semibold">
              {formatDayHeading(day.date)}
              <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
                {day.rows.length} game{day.rows.length === 1 ? '' : 's'}
              </span>
            </h2>

            {/* Below sm: one section per field, stacked top to bottom. */}
            <div className="flex flex-col gap-4 sm:hidden">
              {sections.map((section) => (
                <div key={section.key}>
                  <div
                    className={clsx(
                      'border-b pb-1',
                      section.amber ? 'border-amber-500/40' : 'border-ink-200 dark:border-ink-700',
                    )}
                  >
                    <div
                      className={clsx(
                        'text-sm font-medium',
                        section.amber && 'text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {section.label}
                    </div>
                    <div className="text-xs text-ink-500 dark:text-ink-400">{section.sublabel}</div>
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {section.rows.map((row) => (
                      <GameBlock key={row.id} row={row} orgSlug={orgSlug} linkGames={linkGames} />
                    ))}
                    {section.rows.length === 0 && (
                      <p className="rounded-lg border border-dashed border-ink-300 px-2 py-3 text-center text-xs text-ink-500 dark:border-ink-600 dark:text-ink-400">
                        free
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* sm and up: the side-by-side field grid, sideways-scrollable if it's wider
                than the viewport. */}
            <div className="hidden overflow-x-auto sm:block">
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: `repeat(${Math.max(1, sections.length)}, minmax(190px, 1fr))` }}
              >
                {sections.map((section) => (
                  <div key={section.key} className="flex flex-col gap-2">
                    <div
                      className={clsx(
                        'border-b pb-1',
                        section.amber ? 'border-amber-500/40' : 'border-ink-200 dark:border-ink-700',
                      )}
                    >
                      <div
                        className={clsx(
                          'text-sm font-medium',
                          section.amber && 'text-amber-700 dark:text-amber-300',
                        )}
                      >
                        {section.label}
                      </div>
                      <div className="text-xs text-ink-500 dark:text-ink-400">{section.sublabel}</div>
                    </div>
                    {section.rows.map((row) => (
                      <GameBlock key={row.id} row={row} orgSlug={orgSlug} linkGames={linkGames} />
                    ))}
                    {section.rows.length === 0 && (
                      <p className="rounded-lg border border-dashed border-ink-300 px-2 py-3 text-center text-xs text-ink-500 dark:border-ink-600 dark:text-ink-400">
                        free
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}

function GameBlock({
  row,
  orgSlug,
  linkGames,
}: {
  row: ScheduleRow
  orgSlug: string
  linkGames: boolean
}) {
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium tabular-nums">
          {formatClockInZone(row.startTime, row.timezone)}
        </span>
        <span className="text-xs text-ink-500 dark:text-ink-400">{row.divisionName}</span>
      </div>
      <div className="mt-1 text-sm leading-snug">
        {row.homeTeamName}
        <span className="text-ink-500 dark:text-ink-400"> v </span>
        {row.awayTeamName}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-500 dark:text-ink-400">
        <span>
          {row.officials.length === 0 ? (
            <span className="text-amber-700 dark:text-amber-300">no officials</span>
          ) : (
            `${row.officials.length} official${row.officials.length === 1 ? '' : 's'}`
          )}
        </span>
        {row.status !== 'scheduled' && <StatusChip status={row.status} />}
      </div>
    </>
  )

  const shell =
    'block rounded-lg border border-ink-200 bg-white p-2.5 text-left dark:border-ink-700 dark:bg-ink-900'

  return linkGames ? (
    <Link href={`/app/${orgSlug}/games/${row.id}`} className={clsx(shell, 'hover:border-turf-500')}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  )
}

/**
 * Per-entity grouping: one section per team, venue or referee, each with its own
 * count. Used by the team/venue/referee views, which differ only in how a row is
 * keyed and labelled.
 */
export function ScheduleGrouped({
  rows,
  orgSlug,
  keysOf,
  emptyLabel,
  linkGames = true,
}: {
  rows: ScheduleRow[]
  orgSlug: string
  /** A row can belong to two groups at once — both teams in a match, for instance. */
  keysOf: (row: ScheduleRow) => Array<{ id: string; label: string; sublabel?: string }>
  emptyLabel: string
  linkGames?: boolean
}) {
  const groups = new Map<string, { label: string; sublabel?: string; rows: ScheduleRow[] }>()
  for (const row of rows) {
    for (const key of keysOf(row)) {
      const group = groups.get(key.id)
      if (group) group.rows.push(row)
      else groups.set(key.id, { label: key.label, sublabel: key.sublabel, rows: [row] })
    }
  }

  if (groups.size === 0) return <EmptyState>{emptyLabel}</EmptyState>

  return (
    <div className="space-y-4">
      {[...groups.entries()]
        .sort(([, a], [, b]) => a.label.localeCompare(b.label))
        .map(([id, group]) => (
          <Card key={id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">
                {group.label}
                {group.sublabel && (
                  <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
                    {group.sublabel}
                  </span>
                )}
              </h2>
              <span className="text-sm text-ink-500 dark:text-ink-400">
                {group.rows.length} game{group.rows.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                  {group.rows.map((row) => (
                    <tr key={`${id}:${row.id}`}>
                      <td className="py-2 pr-4 whitespace-nowrap text-xs tabular-nums text-ink-600 dark:text-ink-300">
                        {new Date(row.startTime).toLocaleDateString('en-US', {
                          timeZone: row.timezone,
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                        <div>{formatClockInZone(row.startTime, row.timezone)}</div>
                      </td>
                      <td className="py-2 pr-4">
                        <Match row={row} orgSlug={orgSlug} linkGames={linkGames} />
                        <div className="text-xs text-ink-500 dark:text-ink-400">
                          {row.divisionName}
                          {row.venueName && ` · ${row.venueName} · ${row.fieldName}`}
                        </div>
                      </td>
                      <td className="py-2 text-right text-xs">
                        <StatusChip status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
    </div>
  )
}
