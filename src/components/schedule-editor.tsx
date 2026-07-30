'use client'

import { useState, type DragEvent } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { RequestError, api } from '@/lib/client'
import { Alert, Card, EmptyState, buttonClass, inputClass, secondaryButtonClass } from './ui'
import { formatDayHeading } from './schedule-views'
import type { GridCell, GridGame, ScheduleGrid } from '@/lib/schedule/grid'

/**
 * Drag-and-drop schedule editing (acceptance scenario 4).
 *
 * The flow is deliberately server-decided. A drop PATCHes the game with no override
 * reason; if the placement breaks a hard constraint the endpoint refuses with 409 and
 * the list of violations, which is what this renders. Only then does a reason box
 * appear, and confirming re-sends the same move with the reason attached — where it is
 * recorded on the audit event.
 *
 * The client never decides whether a placement is legal. It cannot: the rules involve
 * rows it has not loaded, and trusting it would put the constraint check on the wrong
 * side of the wire.
 */

type Conflict = { kind: string; message: string }

type PendingMove = {
  game: GridGame
  fieldId: string
  startTime: string
  cellLabel: string
  conflicts: Conflict[]
}

const CONFLICT_LABELS: Record<string, string> = {
  field_double_booked: 'Field double-booked',
  team_double_booked: 'Team double-booked',
  outside_field_availability: 'Outside field availability',
  blackout_date: 'Blackout date',
  referee_unavailable: 'Referee unavailable',
  referee_daily_cap: 'Referee over daily cap',
  referee_conflict_of_interest: 'Referee conflict of interest',
}

export function ScheduleEditor({ orgId, grid }: { orgId: string; grid: ScheduleGrid }) {
  const router = useRouter()
  const [dragging, setDragging] = useState<GridGame | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingMove | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cellKey = (cell: GridCell) => `${cell.fieldId}|${cell.startTime}`

  async function move(
    game: GridGame,
    fieldId: string,
    startTime: string,
    cellLabel: string,
    overrideReason?: string,
  ) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await api(`/api/orgs/${orgId}/games/${game.id}`, {
        method: 'PATCH',
        body: { fieldId, startTime, ...(overrideReason ? { overrideReason } : {}) },
      })
      setPending(null)
      setReason('')
      setNote(
        overrideReason
          ? `Moved ${game.homeTeamName} v ${game.awayTeamName} to ${cellLabel}, override logged.`
          : `Moved ${game.homeTeamName} v ${game.awayTeamName} to ${cellLabel}.`,
      )
      router.refresh()
    } catch (err) {
      // 409 is the expected answer to an illegal placement, not a failure: it carries
      // the reasons, which the operator needs in order to decide about overriding.
      if (err instanceof RequestError && err.status === 409) {
        const details = err.details as { conflicts?: Conflict[] } | null
        setPending({
          game,
          fieldId,
          startTime,
          cellLabel,
          conflicts: details?.conflicts ?? [{ kind: 'unknown', message: err.message }],
        })
      } else {
        setError(err instanceof Error ? err.message : 'Could not move that game.')
      }
    } finally {
      setBusy(false)
    }
  }

  function onDrop(event: DragEvent, cell: GridCell, cellLabel: string) {
    event.preventDefault()
    setHover(null)
    const game = dragging
    setDragging(null)
    if (!game) return
    // Dropping a game back where it already is is a no-op, not an error.
    if (cell.games.some((existing) => existing.id === game.id)) return
    void move(game, cell.fieldId, cell.startTime, cellLabel)
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind="success">{note}</Alert>}

      {pending && (
        <Card className="border-amber-500/60">
          <h3 className="text-base font-semibold text-amber-800 dark:text-amber-200">
            That move breaks {pending.conflicts.length === 1 ? 'a hard constraint' : 'hard constraints'}
          </h3>
          <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">
            Moving <strong>{pending.game.homeTeamName} v {pending.game.awayTeamName}</strong> to{' '}
            {pending.cellLabel} was refused. Nothing has changed yet.
          </p>

          <ul className="mt-3 space-y-2">
            {pending.conflicts.map((conflict, index) => (
              <li
                key={`${conflict.kind}:${index}`}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
              >
                <span className="font-medium">
                  {CONFLICT_LABELS[conflict.kind] ?? conflict.kind}
                </span>
                <div className="text-ink-700 dark:text-ink-200">{conflict.message}</div>
              </li>
            ))}
          </ul>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium">
              Reason for overriding
              <span className="ml-1 font-normal text-ink-500 dark:text-ink-400">
                — recorded against this game, permanently
              </span>
            </span>
            <input
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Both clubs agreed to share the field for a doubleheader"
              autoFocus
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || reason.trim().length === 0}
              onClick={() =>
                void move(
                  pending.game,
                  pending.fieldId,
                  pending.startTime,
                  pending.cellLabel,
                  reason.trim(),
                )
              }
            >
              {busy ? 'Saving…' : 'Override and move'}
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => {
                setPending(null)
                setReason('')
              }}
            >
              Cancel
            </button>
          </div>
          {reason.trim().length === 0 && (
            <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
              A reason is required — the server refuses an override without one.
            </p>
          )}
        </Card>
      )}

      {grid.unplaced.length > 0 && (
        <Card>
          <h3 className="text-base font-semibold">Not yet placed</h3>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            Drag one of these onto a slot to give it a field and a kickoff.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {grid.unplaced.map((game) => (
              <GameChip
                key={game.id}
                game={game}
                dragging={dragging?.id === game.id}
                onDragStart={() => setDragging(game)}
                onDragEnd={() => setDragging(null)}
              />
            ))}
          </div>
        </Card>
      )}

      {grid.days.length === 0 ? (
        <EmptyState>No placed games to edit yet.</EmptyState>
      ) : (
        grid.days.map((day) => (
          <Card key={day.date}>
            <h2 className="mb-3 text-base font-semibold">{formatDayHeading(day.date)}</h2>

            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-1 text-sm">
                <thead>
                  <tr>
                    <th className="w-16 text-left text-xs font-medium uppercase tracking-wide text-ink-500 dark:text-ink-400">
                      Time
                    </th>
                    {grid.columns.map((column) => (
                      <th key={column.id} className="min-w-[180px] text-left">
                        <div className="text-sm font-medium">{column.fieldName}</div>
                        <div className="text-xs font-normal text-ink-500 dark:text-ink-400">
                          {column.venueName}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {day.rows.map((timeRow) => (
                    <tr key={timeRow.minute}>
                      <th className="align-top text-left text-xs font-medium tabular-nums text-ink-600 dark:text-ink-300">
                        {timeRow.label}
                      </th>
                      {timeRow.cells.map((cell) => {
                        const key = cellKey(cell)
                        const label = `${grid.columns.find((c) => c.id === cell.fieldId)?.fieldName ?? 'field'} at ${timeRow.label}`
                        return (
                          <td
                            key={key}
                            onDragOver={(event) => {
                              event.preventDefault()
                              setHover(key)
                            }}
                            onDragLeave={() => setHover((current) => (current === key ? null : current))}
                            onDrop={(event) => onDrop(event, cell, label)}
                            className={clsx(
                              'align-top rounded-lg border border-dashed p-1 transition',
                              hover === key
                                ? 'border-turf-500 bg-turf-500/10'
                                : 'border-ink-200 dark:border-ink-700',
                              cell.games.length > 1 && 'border-red-400 bg-red-500/5',
                            )}
                          >
                            <div className="flex min-h-[52px] flex-col gap-1">
                              {cell.games.map((game) => (
                                <GameChip
                                  key={game.id}
                                  game={game}
                                  dragging={dragging?.id === game.id}
                                  onDragStart={() => setDragging(game)}
                                  onDragEnd={() => setDragging(null)}
                                />
                              ))}
                              {cell.games.length > 1 && (
                                <span className="px-1 text-[11px] font-medium text-red-700 dark:text-red-300">
                                  {cell.games.length} games on one field
                                </span>
                              )}
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
              Times are each field&apos;s local wall clock. Dropping across venues keeps the local
              time and changes the underlying instant.
            </p>
          </Card>
        ))
      )}
    </div>
  )
}

function GameChip({
  game,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  game: GridGame
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
}) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        // Firefox will not start a drag without payload on the transfer.
        event.dataTransfer.setData('text/plain', game.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      aria-grabbed={dragging}
      className={clsx(
        'cursor-grab rounded-lg border bg-white px-2 py-1.5 text-xs leading-snug shadow-sm active:cursor-grabbing dark:bg-ink-900',
        dragging
          ? 'border-turf-500 opacity-50'
          : 'border-ink-200 hover:border-turf-500 dark:border-ink-700',
      )}
    >
      <div className="font-medium">
        {game.homeTeamName}
        <span className="font-normal text-ink-500 dark:text-ink-400"> v </span>
        {game.awayTeamName}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
        {game.divisionName}
        {game.officialCount === 0 ? (
          <span className="ml-1 text-amber-700 dark:text-amber-300">· no officials</span>
        ) : (
          ` · ${game.officialCount} official${game.officialCount === 1 ? '' : 's'}`
        )}
      </div>
    </div>
  )
}
