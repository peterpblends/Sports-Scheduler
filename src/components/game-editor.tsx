'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { RequestError, api } from '@/lib/client'
import {
  Alert,
  Card,
  EmptyState,
  Label,
  buttonClass,
  dangerButtonClass,
  inputClass,
  secondaryButtonClass,
} from './ui'

/**
 * Editing one game, and staffing it.
 *
 * Two rules shape this file:
 *
 *  1. **Local time in, local time out.** The operator types the kickoff in the venue's
 *     wall clock; the server is handed the UTC instant the page was told that reading
 *     denotes. Nobody is asked to type an ISO string with a Z on the end.
 *  2. **The server decides legality.** Both the move and the assignment go out without
 *     an override; a 409 comes back naming the constraints, and only then is a reason
 *     asked for. Identical to the drag-and-drop flow, on purpose.
 */

type Conflict = { kind: string; message: string }

export const CONFLICT_LABELS: Record<string, string> = {
  field_double_booked: 'Field double-booked',
  team_double_booked: 'Team double-booked',
  outside_field_availability: 'Outside field availability',
  blackout_date: 'Blackout date',
  referee_unavailable: 'Referee unavailable',
  referee_daily_cap: 'Referee over daily cap',
  referee_conflict_of_interest: 'Conflict of interest',
}

export function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <ul className="space-y-2">
      {conflicts.map((conflict, index) => (
        <li
          key={`${conflict.kind}:${index}`}
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span className="font-medium">{CONFLICT_LABELS[conflict.kind] ?? conflict.kind}</span>
          <div className="text-ink-700 dark:text-ink-200">{conflict.message}</div>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Game details
// ---------------------------------------------------------------------------

const STATUSES = ['scheduled', 'confirmed', 'played', 'postponed', 'cancelled', 'forfeited'] as const

export function GameEditor({
  orgId,
  gameId,
  timezone,
  initial,
  fields,
}: {
  orgId: string
  gameId: string
  /** The venue's zone, shown so nobody has to guess which clock they are setting. */
  timezone: string
  initial: {
    /** `YYYY-MM-DD` as read in `timezone`. */
    localDate: string
    /** `HH:MM` as read in `timezone`. */
    localTime: string
    fieldId: string | null
    durationMinutes: number
    status: string
    homeScore: number | null
    awayScore: number | null
    notes: string | null
  }
  fields: Array<{ id: string; label: string; timezone: string }>
}) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const targetZone = fields.find((field) => field.id === form.fieldId)?.timezone ?? timezone

  async function save(overrideReason?: string) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await api(`/api/orgs/${orgId}/games/${gameId}`, {
        method: 'PATCH',
        body: {
          // The server converts the local reading in the target field's zone, so a
          // move between venues keeps the wall-clock time the operator chose.
          localDate: form.localDate,
          localTime: form.localTime,
          fieldId: form.fieldId,
          durationMinutes: form.durationMinutes,
          status: form.status,
          homeScore: form.homeScore,
          awayScore: form.awayScore,
          notes: form.notes,
          ...(overrideReason ? { overrideReason } : {}),
        },
      })
      setConflicts(null)
      setReason('')
      setNote('Saved.')
      router.refresh()
    } catch (err) {
      if (err instanceof RequestError && err.status === 409) {
        const details = err.details as { conflicts?: Conflict[] } | null
        setConflicts(details?.conflicts ?? [{ kind: 'unknown', message: err.message }])
      } else {
        setError(err instanceof Error ? err.message : 'Could not save.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold">Edit this game</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        Kickoff is the wall clock at <strong>{targetZone}</strong>. Stored as UTC.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="localDate">Date</Label>
          <input
            id="localDate"
            type="date"
            className={inputClass}
            value={form.localDate}
            onChange={(event) => set('localDate', event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="localTime">Kickoff</Label>
          <input
            id="localTime"
            type="time"
            className={inputClass}
            value={form.localTime}
            onChange={(event) => set('localTime', event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="fieldId">Field</Label>
          <select
            id="fieldId"
            className={inputClass}
            value={form.fieldId ?? ''}
            onChange={(event) => set('fieldId', event.target.value || null)}
          >
            <option value="">Not placed</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="durationMinutes">Minutes</Label>
          <input
            id="durationMinutes"
            type="number"
            min={1}
            className={inputClass}
            value={form.durationMinutes}
            onChange={(event) => set('durationMinutes', Number(event.target.value))}
          />
        </div>
        <div>
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            className={inputClass}
            value={form.status}
            onChange={(event) => set('status', event.target.value)}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="homeScore">Home score</Label>
            <input
              id="homeScore"
              type="number"
              min={0}
              className={inputClass}
              value={form.homeScore ?? ''}
              onChange={(event) =>
                set('homeScore', event.target.value === '' ? null : Number(event.target.value))
              }
            />
          </div>
          <div>
            <Label htmlFor="awayScore">Away score</Label>
            <input
              id="awayScore"
              type="number"
              min={0}
              className={inputClass}
              value={form.awayScore ?? ''}
              onChange={(event) =>
                set('awayScore', event.target.value === '' ? null : Number(event.target.value))
              }
            />
          </div>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <input
            id="notes"
            className={inputClass}
            value={form.notes ?? ''}
            onChange={(event) => set('notes', event.target.value || null)}
            placeholder="Anything a coach or official should know"
          />
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {note && (
        <div className="mt-4">
          <Alert kind="success">{note}</Alert>
        </div>
      )}

      {conflicts && (
        <div className="mt-4 rounded-lg border border-amber-500/60 p-3">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            That placement breaks {conflicts.length === 1 ? 'a hard constraint' : 'hard constraints'}
          </h3>
          <p className="mb-3 mt-1 text-sm text-ink-600 dark:text-ink-300">
            Nothing has been saved. Give a reason to save it anyway — it is recorded against
            this game.
          </p>
          <ConflictList conflicts={conflicts} />
          <input
            className={clsx(inputClass, 'mt-3')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason for overriding"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || reason.trim().length === 0}
              onClick={() => void save(reason.trim())}
            >
              Override and save
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setConflicts(null)
                setReason('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy}
          onClick={() => {
            setForm(initial)
            setConflicts(null)
            setError(null)
            setNote(null)
          }}
        >
          Reset
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Officiating crew
// ---------------------------------------------------------------------------

type Candidate = {
  refereeId: string
  name: string
  certification: string | null
  alreadyAssigned: boolean
  gamesThatDay: number
  maxGamesPerDay: number
  conflicts: Conflict[]
}

const POSITIONS = ['center', 'AR1', 'AR2', 'scorekeeper'] as const

export function OfficialsPanel({
  orgId,
  gameId,
  assignments,
  canAssign,
  ownAssignmentIds,
}: {
  orgId: string
  gameId: string
  assignments: Array<{ id: string; refereeName: string; position: string; status: string }>
  canAssign: boolean
  /** Assignment ids the signed-in referee may accept or decline. */
  ownAssignmentIds: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [position, setPosition] = useState<string>('center')
  const [pending, setPending] = useState<{ candidate: Candidate; conflicts: Conflict[] } | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const taken = new Set(assignments.map((assignment) => assignment.position))

  useEffect(() => {
    if (!open || candidates) return
    let cancelled = false
    void (async () => {
      try {
        const data = await api<{ candidates: Candidate[] }>(
          `/api/orgs/${orgId}/games/${gameId}/officials/candidates`,
        )
        if (!cancelled) setCandidates(data.candidates)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load officials.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, candidates, orgId, gameId])

  async function assign(candidate: Candidate, overrideReason?: string) {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/orgs/${orgId}/games/${gameId}/officials`, {
        method: 'POST',
        body: {
          refereeId: candidate.refereeId,
          position,
          ...(overrideReason ? { overrideReason } : {}),
        },
      })
      setPending(null)
      setReason('')
      setCandidates(null)
      router.refresh()
    } catch (err) {
      if (err instanceof RequestError && err.status === 409) {
        const details = err.details as { conflicts?: Conflict[] } | null
        // A duplicate position comes back as a 409 too, but with no conflict list —
        // that is a plain error, not something to offer an override for.
        if (details?.conflicts?.length) {
          setPending({ candidate, conflicts: details.conflicts })
        } else {
          setError(err.message)
        }
      } else {
        setError(err instanceof Error ? err.message : 'Could not assign.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function act(path: string, body?: unknown, method: 'PATCH' | 'DELETE' = 'PATCH') {
    setBusy(true)
    setError(null)
    try {
      await api(path, { method, body })
      setCandidates(null)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the assignment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Officials</h2>
        {canAssign && (
          <button
            type="button"
            className="text-sm text-turf-600 hover:underline"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Close' : 'Assign an official'}
          </button>
        )}
      </div>

      {assignments.length === 0 ? (
        <div className="mt-3">
          <EmptyState>Nobody assigned yet.</EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
          {assignments.map((assignment) => (
            <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{assignment.refereeName}</span>
                <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                  {assignment.position} · {assignment.status}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {ownAssignmentIds.includes(assignment.id) && assignment.status !== 'accepted' && (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={busy}
                    onClick={() =>
                      void act(`/api/orgs/${orgId}/games/${gameId}/officials/${assignment.id}`, {
                        status: 'accepted',
                      })
                    }
                  >
                    Accept
                  </button>
                )}
                {ownAssignmentIds.includes(assignment.id) && assignment.status !== 'declined' && (
                  <button
                    type="button"
                    className={dangerButtonClass}
                    disabled={busy}
                    onClick={() =>
                      void act(`/api/orgs/${orgId}/games/${gameId}/officials/${assignment.id}`, {
                        status: 'declined',
                      })
                    }
                  >
                    Decline
                  </button>
                )}
                {canAssign && (
                  <button
                    type="button"
                    className={dangerButtonClass}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/api/orgs/${orgId}/games/${gameId}/officials/${assignment.id}`,
                        undefined,
                        'DELETE',
                      )
                    }
                  >
                    Unassign
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {pending && (
        <div className="mt-4 rounded-lg border border-amber-500/60 p-3">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {pending.candidate.name} cannot take this game
          </h3>
          <p className="mb-3 mt-1 text-sm text-ink-600 dark:text-ink-300">
            Nothing has been assigned. A conflict of interest is the one to think hardest about
            before overriding.
          </p>
          <ConflictList conflicts={pending.conflicts} />
          <input
            className={clsx(inputClass, 'mt-3')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason for overriding"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || reason.trim().length === 0}
              onClick={() => void assign(pending.candidate, reason.trim())}
            >
              Override and assign
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setPending(null)
                setReason('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {open && canAssign && (
        <div className="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
          <Label htmlFor="position">Position</Label>
          <select
            id="position"
            className={inputClass}
            value={position}
            onChange={(event) => setPosition(event.target.value)}
          >
            {POSITIONS.map((candidate) => (
              <option key={candidate} value={candidate} disabled={taken.has(candidate)}>
                {candidate}
                {taken.has(candidate) ? ' — already filled' : ''}
              </option>
            ))}
          </select>

          {candidates === null ? (
            <p className="mt-3 text-sm text-ink-500 dark:text-ink-400">Loading officials…</p>
          ) : candidates.length === 0 ? (
            <div className="mt-3">
              <EmptyState>No officials in this organization yet.</EmptyState>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {candidates.map((candidate) => (
                <li key={candidate.refereeId} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{candidate.name}</span>
                      <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                        {candidate.certification ?? 'uncertified'} · {candidate.gamesThatDay}/
                        {candidate.maxGamesPerDay} that day
                      </span>
                    </span>
                    {candidate.alreadyAssigned ? (
                      <span className="text-xs text-ink-500 dark:text-ink-400">on this game</span>
                    ) : (
                      <button
                        type="button"
                        className={
                          candidate.conflicts.length === 0 ? buttonClass : secondaryButtonClass
                        }
                        disabled={busy || taken.has(position)}
                        onClick={() => void assign(candidate)}
                      >
                        {candidate.conflicts.length === 0 ? 'Assign' : 'Assign anyway…'}
                      </button>
                    )}
                  </div>
                  {candidate.conflicts.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-300">
                      {candidate.conflicts.map((conflict, index) => (
                        <li key={`${conflict.kind}:${index}`}>
                          {CONFLICT_LABELS[conflict.kind] ?? conflict.kind}: {conflict.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
