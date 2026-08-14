'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RequestError, api } from '@/lib/client'
import { Alert, buttonClass, inputClass, secondaryButtonClass } from './ui'

/**
 * The referee's own actions: answer an assignment, ask for a spare game, take a
 * request back.
 *
 * Every one of these is a one-click action with a visible outcome, because the
 * person using it is standing in a car park on a phone. Optimistic UI is
 * deliberately avoided — a decline that silently failed would have a referee
 * believe they are off a game they are still on.
 */

type Conflict = { kind: string; message: string }

/**
 * Short labels for the conflict kinds.
 *
 * `referee_unavailable` is deliberately vague here because the kind is: it covers
 * being outside a weekly window, a blackout, an overlapping assignment, and too
 * little travel time between venues. Labelling all four "outside your availability"
 * told referees the wrong thing about the last two — so the server's `message`,
 * which distinguishes them, is what actually gets rendered, and these are only the
 * heading above it.
 */
const CONFLICT_LABELS: Record<string, string> = {
  referee_unavailable: 'Not available',
  referee_daily_cap: 'Over your daily limit',
  referee_conflict_of_interest: 'Conflict of interest',
  field_double_booked: 'Field double-booked',
  team_double_booked: 'Team already playing',
  outside_field_availability: 'Outside field availability',
  blackout_date: 'Blackout date',
}

/**
 * The server writes conflict messages for an assigner, so they name the referee in
 * the third person. On the referee's own page that reads oddly, so the leading name
 * is turned into "You". Falls back to the message untouched when it does not start
 * with their name, which is what happens for any message not about them.
 */
function inSecondPerson(message: string, name: string | undefined): string {
  if (!name || !message.startsWith(`${name} `)) return message
  // The verb is not always the first word — "Wei Chen already has an overlapping
  // assignment" puts an adverb in front of it — so this conjugates every occurrence
  // rather than only a leading one. Safe for the fixed set of messages
  // `detectOfficialConflicts` produces, none of which has a second subject; it is
  // not a general-purpose rewriter, and a new message with one would need checking.
  const rest = message
    .slice(name.length + 1)
    .replace(/\bis\b/g, 'are')
    .replace(/\bhas\b/g, 'have')
    .replace(/\bneeds\b/g, 'need')
  return `You ${rest}`
}

function useAction() {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(null)
    }
  }

  return { busy, error, run, setError }
}

/** Accept or decline one assignment. */
export function RespondButtons({
  orgId,
  gameId,
  assignmentId,
  status,
}: {
  orgId: string
  gameId: string
  assignmentId: string
  status: 'pending' | 'accepted' | 'declined'
}) {
  const { busy, error, run } = useAction()
  const endpoint = `/api/orgs/${orgId}/games/${gameId}/officials/${assignmentId}`

  const set = (next: 'accepted' | 'declined') =>
    run(next, () => api(endpoint, { method: 'PATCH', body: { status: next } }))

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {status !== 'accepted' && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null}
            onClick={() => set('accepted')}
          >
            {busy === 'accepted' ? 'Saving…' : status === 'declined' ? 'Actually, accept' : 'Accept'}
          </button>
        )}
        {status !== 'declined' && (
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy !== null}
            onClick={() => set('declined')}
          >
            {busy === 'declined' ? 'Saving…' : 'Decline'}
          </button>
        )}
      </div>
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
  )
}

/**
 * Ask for a game that is short an official.
 *
 * When the server refuses on a hard rule the reason is shown in place. There is no
 * override control here on purpose: overriding a conflict of interest is an
 * assigner's decision, and offering a referee a button to do it for themselves
 * would make the rule decorative.
 */
export function RequestToOfficiate({
  orgId,
  gameId,
  openPositions,
  conflicts,
  refereeName,
}: {
  orgId: string
  gameId: string
  openPositions: string[]
  conflicts: Conflict[]
  /** Used only to rewrite the server's third-person conflict messages. */
  refereeName?: string
}) {
  const { busy, error, run, setError } = useAction()
  const [position, setPosition] = useState(openPositions[0] ?? 'center')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const [refused, setRefused] = useState<Conflict[] | null>(null)

  if (conflicts.length > 0) {
    return (
      <div className="max-w-xs text-right text-xs">
        <span className="font-medium text-amber-700 dark:text-amber-300">
          You cannot take this one
        </span>
        <ul className="mt-0.5 text-ink-500 dark:text-ink-400">
          {conflicts.map((conflict, index) => (
            // The specific message, not just the kind's label: "you already have an
            // overlapping assignment" and "you are not available at that local time"
            // are both `referee_unavailable` and need different actions from you.
            <li key={index}>{inSecondPerson(conflict.message, refereeName)}</li>
          ))}
        </ul>
      </div>
    )
  }

  if (!open) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
        Ask for this game
      </button>
    )
  }

  const submit = () =>
    run('ask', async () => {
      setRefused(null)
      try {
        await api(`/api/orgs/${orgId}/games/${gameId}/officiating-requests`, {
          body: { position, ...(note.trim() ? { note: note.trim() } : {}) },
        })
      } catch (err) {
        if (err instanceof RequestError && err.status === 409) {
          const details = err.details as { conflicts?: Conflict[] } | null
          if (details?.conflicts?.length) {
            setRefused(details.conflicts)
            setError(null)
            // Swallowed so the conflict list is what the referee sees, rather than
            // a generic message competing with it.
            return
          }
        }
        throw err
      }
    })

  return (
    <div className="w-full max-w-sm space-y-2 text-left">
      <div className="flex gap-2">
        <select
          className={inputClass}
          value={position}
          onChange={(event) => setPosition(event.target.value)}
          aria-label="Position"
        >
          {openPositions.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={submit}>
          {busy === 'ask' ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => {
            setOpen(false)
            setRefused(null)
          }}
        >
          Cancel
        </button>
      </div>
      <input
        className={inputClass}
        placeholder="Anything the assigner should know (optional)"
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
      />
      {refused && (
        <Alert>
          <span className="font-medium">This game is not available to you.</span>
          <ul className="mt-1 list-disc pl-4">
            {refused.map((conflict, index) => (
              <li key={index}>
                <span className="font-medium">
                  {CONFLICT_LABELS[conflict.kind] ?? conflict.kind}
                </span>{' '}
                — {inSecondPerson(conflict.message, refereeName)}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  )
}

/** Take back a request that has not been answered yet. */
export function WithdrawRequest({ orgId, requestId }: { orgId: string; requestId: string }) {
  const { busy, error, run } = useAction()

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={busy !== null}
        onClick={() =>
          run('withdraw', () =>
            api(`/api/orgs/${orgId}/officiating-requests/${requestId}`, { method: 'DELETE' }),
          )
        }
      >
        {busy ? 'Withdrawing…' : 'Withdraw'}
      </button>
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
  )
}

/**
 * An assigner answering a request.
 *
 * Rejecting asks for a note first. A referee who volunteered and got a bare "no"
 * learns nothing, and the note is stored on the request so they can read it without
 * holding `audit:read`.
 */
export function DecideRequest({
  orgId,
  requestId,
  refereeName,
}: {
  orgId: string
  requestId: string
  refereeName: string
}) {
  const { busy, error, run, setError } = useAction()
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)
  const [overrideReason, setOverrideReason] = useState('')

  const endpoint = `/api/orgs/${orgId}/officiating-requests/${requestId}`

  const approve = (reason?: string) =>
    run('approve', async () => {
      setConflicts(null)
      try {
        await api(endpoint, {
          method: 'PATCH',
          body: { decision: 'approved', ...(reason ? { overrideReason: reason } : {}) },
        })
      } catch (err) {
        if (err instanceof RequestError && err.status === 409) {
          const details = err.details as { conflicts?: Conflict[] } | null
          if (details?.conflicts?.length) {
            setConflicts(details.conflicts)
            setError(null)
            return
          }
        }
        throw err
      }
    })

  if (conflicts) {
    return (
      <div className="w-full max-w-md space-y-2">
        <Alert>
          <span className="font-medium">
            {refereeName} cannot take this game without an override.
          </span>
          <ul className="mt-1 list-disc pl-4">
            {conflicts.map((conflict, index) => (
              <li key={index}>
                <span className="font-medium">
                  {CONFLICT_LABELS[conflict.kind] ?? conflict.kind}
                </span>{' '}
                — {conflict.message}
              </li>
            ))}
          </ul>
        </Alert>
        <input
          className={inputClass}
          placeholder="Why are you overriding this? (recorded)"
          value={overrideReason}
          onChange={(event) => setOverrideReason(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            // A conflict of interest is the one an assigner should almost never
            // override, so the reason is mandatory before the button works at all.
            disabled={overrideReason.trim().length < 3 || busy !== null}
            onClick={() => approve(overrideReason.trim())}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve anyway'}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              setConflicts(null)
              setOverrideReason('')
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (rejecting) {
    return (
      <div className="w-full max-w-md space-y-2">
        <input
          className={inputClass}
          placeholder={`Why not? ${refereeName} will see this.`}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null}
            onClick={() =>
              run('reject', () =>
                api(endpoint, {
                  method: 'PATCH',
                  body: {
                    decision: 'rejected',
                    ...(note.trim() ? { decisionNote: note.trim() } : {}),
                  },
                }),
              )
            }
          >
            {busy === 'reject' ? 'Sending…' : 'Turn it down'}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setRejecting(false)}
          >
            Cancel
          </button>
        </div>
        {error && <Alert>{error}</Alert>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={busy !== null}
          onClick={() => approve()}
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy !== null}
          onClick={() => setRejecting(true)}
        >
          Turn down
        </button>
      </div>
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
  )
}
