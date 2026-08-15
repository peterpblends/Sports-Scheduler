'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'
import {
  Alert,
  Card,
  EmptyState,
  buttonClass,
  dangerButtonClass,
  inputClass,
  secondaryButtonClass,
} from './ui'

type VersionRow = {
  id: string
  number: number
  label: string
  note: string | null
  status: 'draft' | 'published' | 'archived'
  source: 'generated' | 'manual_save' | 'restore'
  author: string
  createdAt: string
  publishedAt: string | null
  restoredFromId: string | null
  gameCount: number
  isPublished: boolean
}

type DiffSide = {
  id: string
  number: number | null
  label: string
  status: string
  createdAt: string | null
  author: string | null
  gameCount: number
}

type DiffResponse = {
  from: DiffSide
  to: DiffSide
  counts: {
    before: number
    after: number
    added: number
    removed: number
    moved: number
    officialsChanged: number
    unchanged: number
  }
  added: Array<{ gameId: string; round: number | null; division: string; match: string; where: string | null; localStartTime: string }>
  removed: Array<{ gameId: string; round: number | null; division: string; match: string; where: string | null; localStartTime: string }>
  moved: Array<{
    gameId: string
    round: number | null
    match: string
    matchedBy: string
    timeChanged: boolean
    fieldChanged: boolean
    statusChanged: boolean
    scoreChanged: boolean
    minutesMoved: number
    before: { localStartTime: string; where: string | null; status: string; score: string | null }
    after: { localStartTime: string; where: string | null; status: string; score: string | null }
  }>
  officialsChanged: Array<{
    gameId: string
    match: string
    localStartTime: string
    added: string[]
    removed: string[]
    statusChanged: string[]
  }>
}

const SOURCE_LABEL: Record<VersionRow['source'], string> = {
  generated: 'generated',
  manual_save: 'saved by hand',
  restore: 'restored',
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    published: 'bg-turf-500/15 text-turf-700 dark:text-turf-500',
    draft: 'bg-ink-500/15 text-ink-600 dark:text-ink-300',
    archived: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    live: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${styles[status] ?? styles.draft}`}>
      {status}
    </span>
  )
}

/**
 * Version history for a season: the list, a side-by-side diff between any two, and
 * publish / restore.
 *
 * Restoring is presented as what it is — an action that adds a version rather than
 * rewinding to one — so nobody expects it to erase what came after.
 */
export function VersionHistory({
  orgId,
  seasonId,
  canPublish,
  canRestore,
  canSave,
}: {
  orgId: string
  seasonId: string
  canPublish: boolean
  canRestore: boolean
  canSave: boolean
}) {
  const router = useRouter()
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('live')
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [diffing, setDiffing] = useState(false)

  async function load() {
    try {
      const data = await api<{ versions: VersionRow[]; publishedVersionId: string | null }>(
        `/api/orgs/${orgId}/seasons/${seasonId}/versions`,
      )
      setVersions(data.versions)
      setPublishedVersionId(data.publishedVersionId)
      // Default the comparison to "latest version versus what is live now".
      if (!from && data.versions.length > 0) setFrom(data.versions[0]!.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load versions.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, seasonId])

  async function act(key: string, work: () => Promise<string>) {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      setNotice(await work())
      await load()
      setDiff(null)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(null)
    }
  }

  async function runDiff() {
    if (!from || !to) return
    setDiffing(true)
    setError(null)
    try {
      setDiff(
        await api<DiffResponse>(
          `/api/orgs/${orgId}/seasons/${seasonId}/versions/diff?from=${from}&to=${to}`,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the diff.')
    } finally {
      setDiffing(false)
    }
  }

  const options = [
    ...versions.map((version) => ({
      value: version.id,
      label: `v${version.number} — ${version.label}`,
    })),
    { value: 'live', label: 'Current working schedule' },
  ]

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Versions</h2>
            <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
              Newest first. Each one is a frozen copy of the schedule — nothing here is ever
              rewritten.
            </p>
          </div>
          {canSave && (
            <button
              type="button"
              disabled={busy !== null}
              className={secondaryButtonClass}
              onClick={() =>
                act('save', async () => {
                  const label = window.prompt('Label for this snapshot?') ?? undefined
                  const result = await api<{ version: { number: number } }>(
                    `/api/orgs/${orgId}/seasons/${seasonId}/versions`,
                    { body: label ? { label } : {} },
                  )
                  return `Saved as v${result.version.number}.`
                })
              }
            >
              {busy === 'save' ? 'Saving…' : 'Save current as a version'}
            </button>
          )}
        </div>

        {loading ? (
          <div className="mt-4">
            <EmptyState>Loading…</EmptyState>
          </div>
        ) : versions.length === 0 ? (
          <div className="mt-4">
            <EmptyState>
              No versions yet. Generating a schedule creates the first one.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-ink-200 dark:divide-ink-700">
            {versions.map((version) => (
              <li key={version.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium tabular-nums">v{version.number}</span>
                    <span className="text-sm">{version.label}</span>
                    <StatusPill status={version.status} />
                    <span className="text-xs text-ink-500 dark:text-ink-400">
                      {SOURCE_LABEL[version.source]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
                    {version.gameCount} game{version.gameCount === 1 ? '' : 's'} · {version.author} ·{' '}
                    {new Date(version.createdAt).toLocaleString()}
                    {version.publishedAt && (
                      <> · published {new Date(version.publishedAt).toLocaleString()}</>
                    )}
                  </div>
                  {version.note && (
                    <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{version.note}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => {
                      setFrom(version.id)
                      setTo('live')
                      setDiff(null)
                    }}
                  >
                    Compare
                  </button>

                  {canPublish && !version.isPublished && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      className={buttonClass}
                      onClick={() =>
                        act(`publish-${version.id}`, async () => {
                          await api(
                            `/api/orgs/${orgId}/seasons/${seasonId}/versions/${version.id}/publish`,
                            { body: {} },
                          )
                          return `v${version.number} is now the published schedule.`
                        })
                      }
                    >
                      {busy === `publish-${version.id}` ? 'Publishing…' : 'Publish'}
                    </button>
                  )}

                  {canRestore && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      className={dangerButtonClass}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Restore v${version.number}? This creates a NEW version with v${version.number}'s content. ` +
                              'Nothing is deleted, and recorded results are left alone.',
                          )
                        ) {
                          return
                        }
                        void act(`restore-${version.id}`, async () => {
                          const result = await api<{
                            version: { number: number }
                            created: number
                            preserved: number
                          }>(
                            `/api/orgs/${orgId}/seasons/${seasonId}/versions/${version.id}/restore`,
                            { body: {} },
                          )
                          return (
                            `Restored v${version.number} as v${result.version.number} — ` +
                            `${result.created} game${result.created === 1 ? '' : 's'} rewritten` +
                            (result.preserved > 0
                              ? `, ${result.preserved} played game${result.preserved === 1 ? '' : 's'} left alone.`
                              : '.')
                          )
                        })
                      }}
                    >
                      {busy === `restore-${version.id}` ? 'Restoring…' : 'Restore'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canPublish && publishedVersionId && (
          <div className="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
            <button
              type="button"
              disabled={busy !== null}
              className={dangerButtonClass}
              onClick={() => {
                if (!window.confirm('Unpublish? Coaches, referees and viewers will see nothing.')) {
                  return
                }
                void act('unpublish', async () => {
                  await api(`/api/orgs/${orgId}/seasons/${seasonId}/publish`, { method: 'DELETE' })
                  return 'Nothing is published for this season now.'
                })
              }}
            >
              {busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish the current schedule'}
            </button>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-base font-semibold">Compare two versions</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Shows games added, removed and moved, and any change to officials.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">From</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass}>
              <option value="">Choose…</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">To</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} className={inputClass}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!from || !to || diffing}
            className={buttonClass}
            onClick={() => void runDiff()}
          >
            {diffing ? 'Comparing…' : 'Compare'}
          </button>
        </div>

        {diff && <DiffView diff={diff} />}
      </Card>
    </div>
  )
}

function DiffView({ diff }: { diff: DiffResponse }) {
  const nothingChanged =
    diff.counts.added === 0 &&
    diff.counts.removed === 0 &&
    diff.counts.moved === 0 &&
    diff.counts.officialsChanged === 0

  return (
    <div className="mt-6 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {[diff.from, diff.to].map((side, index) => (
          <div
            key={side.id}
            className="rounded-lg border border-ink-200 p-3 text-sm dark:border-ink-700"
          >
            <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
              {index === 0 ? 'From' : 'To'}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {side.number === null ? side.label : `v${side.number} — ${side.label}`}
              </span>
              <StatusPill status={side.status} />
            </div>
            <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
              {side.gameCount} game{side.gameCount === 1 ? '' : 's'}
              {side.author && <> · {side.author}</>}
              {side.createdAt && <> · {new Date(side.createdAt).toLocaleString()}</>}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-5">
        {[
          { label: 'Added', value: diff.counts.added },
          { label: 'Removed', value: diff.counts.removed },
          { label: 'Moved', value: diff.counts.moved },
          { label: 'Officials', value: diff.counts.officialsChanged },
          { label: 'Unchanged', value: diff.counts.unchanged },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-ink-200 p-3 dark:border-ink-700"
          >
            <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
              {stat.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{stat.value}</div>
          </div>
        ))}
      </div>

      {nothingChanged && (
        <Alert kind="success">These two versions hold the same schedule.</Alert>
      )}

      {diff.moved.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
            Moved
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Match</th>
                  <th className="pb-2 pr-4 font-medium">Was</th>
                  <th className="pb-2 pr-4 font-medium">Now</th>
                  <th className="pb-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {diff.moved.map((entry) => (
                  <tr key={entry.gameId}>
                    <td className="py-2 pr-4">
                      <div className="font-medium">{entry.match}</div>
                      {entry.round !== null && (
                        <div className="text-xs text-ink-500 dark:text-ink-400">
                          round {entry.round}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-500 dark:text-ink-400">
                      <div>{entry.before.localStartTime}</div>
                      <div>{entry.before.where ?? 'unplaced'}</div>
                      {entry.before.score && <div>score {entry.before.score}</div>}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      <div>{entry.after.localStartTime}</div>
                      <div>{entry.after.where ?? 'unplaced'}</div>
                      {entry.after.score && <div>score {entry.after.score}</div>}
                    </td>
                    <td className="py-2 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {entry.timeChanged && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                            {entry.minutesMoved > 0 ? '+' : ''}
                            {entry.minutesMoved} min
                          </span>
                        )}
                        {entry.fieldChanged && (
                          <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-blue-700 dark:text-blue-300">
                            field
                          </span>
                        )}
                        {entry.statusChanged && (
                          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-700 dark:text-violet-300">
                            {entry.before.status} → {entry.after.status}
                          </span>
                        )}
                        {entry.scoreChanged && (
                          <span className="rounded bg-turf-500/15 px-1.5 py-0.5 text-turf-700 dark:text-turf-500">
                            score
                          </span>
                        )}
                      </div>
                      {entry.matchedBy !== 'game_id' && (
                        <div className="mt-1 text-ink-500 dark:text-ink-400">
                          matched by {entry.matchedBy.replace('_', ' ')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(['added', 'removed'] as const).map((key) =>
        diff[key].length === 0 ? null : (
          <div key={key}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
              {key}
            </h3>
            <ul className="mt-2 divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {diff[key].map((entry) => (
                <li key={entry.gameId} className="flex flex-wrap justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium">{entry.match}</span>
                    <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                      {entry.division}
                      {entry.round !== null && ` · round ${entry.round}`}
                    </span>
                  </span>
                  <span className="text-xs text-ink-500 dark:text-ink-400">
                    {entry.localStartTime}
                    {entry.where && ` · ${entry.where}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}

      {diff.officialsChanged.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
            Officials changed
          </h3>
          <ul className="mt-2 divide-y divide-ink-200 text-sm dark:divide-ink-700">
            {diff.officialsChanged.map((entry) => (
              <li key={entry.gameId} className="py-2">
                <div className="font-medium">{entry.match}</div>
                <div className="text-xs text-ink-500 dark:text-ink-400">{entry.localStartTime}</div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {entry.added.map((name) => (
                    <li key={`a-${name}`} className="text-turf-700 dark:text-turf-500">
                      + {name}
                    </li>
                  ))}
                  {entry.removed.map((name) => (
                    <li key={`r-${name}`} className="text-red-700 dark:text-red-300">
                      − {name}
                    </li>
                  ))}
                  {entry.statusChanged.map((change) => (
                    <li key={`s-${change}`} className="text-ink-600 dark:text-ink-300">
                      {change}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
