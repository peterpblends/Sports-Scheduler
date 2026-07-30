'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client'
import { formatInstantInZone } from '@/lib/time'
import { Alert, Card, EmptyState, inputClass, secondaryButtonClass } from './ui'

type ActivityEvent = {
  id: string
  action: string
  entityType: string
  entityId: string
  actor: { id: string | null; name: string; email: string }
  createdAt: string
  diff: Record<string, { before: unknown; after: unknown }>
  meta: Record<string, unknown>
}

type Facets = {
  actors: Array<{ id: string | null; label: string; count: number }>
  entityTypes: Array<{ value: string; count: number }>
  actions: Array<{ value: string; count: number }>
}

type FeedResponse = { events: ActivityEvent[]; nextCursor: string | null; facets: Facets }

/** Turns `member.role_changed` into "role changed", keeping the entity out of it. */
function describeAction(action: string): string {
  const [, ...rest] = action.split('.')
  return (rest.join('.') || action).replace(/_/g, ' ')
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Audit rows store instants as UTC ISO strings, which is right for the record and wrong
 * for a reader. Given a zone, an instant renders in it — same rule as everywhere else
 * in the app. Without one, the ISO string stands.
 */
function renderValue(value: unknown, timeZone?: string | null): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    if (timeZone && ISO_INSTANT.test(value)) return formatInstantInZone(new Date(value), timeZone)
    return value
  }
  return JSON.stringify(value)
}

/**
 * The global activity feed.
 *
 * Reads straight off the append-only audit log, so it is a record rather than a
 * summary. Filters mirror what the spec asks for: actor, entity type, and date range.
 */
export function ActivityFeed({ orgId }: { orgId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [facets, setFacets] = useState<Facets | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [actorId, setActorId] = useState('')
  const [entityType, setEntityType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  async function load(append = false) {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (actorId) params.set('actorId', actorId)
      if (entityType) params.set('entityType', entityType)
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (append && cursor) params.set('cursor', cursor)

      const data = await api<FeedResponse>(`/api/orgs/${orgId}/activity?${params}`)
      setEvents(append ? [...events, ...data.events] : data.events)
      setFacets(data.facets)
      setCursor(data.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load activity.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, actorId, entityType, from, to])

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Who</span>
            <select value={actorId} onChange={(e) => setActorId(e.target.value)} className={inputClass}>
              <option value="">Anyone</option>
              {facets?.actors
                .filter((actor) => actor.id)
                .map((actor) => (
                  <option key={actor.id} value={actor.id!}>
                    {actor.label} ({actor.count})
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">What</span>
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className={inputClass}
            >
              <option value="">Everything</option>
              {facets?.entityTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.value} ({type.count})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
          </label>
          {(actorId || entityType || from || to) && (
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setActorId('')
                setEntityType('')
                setFrom('')
                setTo('')
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {error && <Alert>{error}</Alert>}

      <Card>
        {loading && events.length === 0 ? (
          <EmptyState>Loading…</EmptyState>
        ) : events.length === 0 ? (
          <EmptyState>Nothing matches those filters.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200 dark:divide-ink-700">
            {events.map((event) => {
              const changes = Object.entries(event.diff ?? {})
              const isOpen = expanded === event.id
              return (
                <li key={event.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{event.actor.name}</span>{' '}
                      <span className="text-ink-600 dark:text-ink-300">
                        {describeAction(event.action)}
                      </span>{' '}
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs dark:bg-ink-900">
                        {event.entityType}
                      </span>
                    </div>
                    <time
                      className="text-xs text-ink-500 dark:text-ink-400"
                      dateTime={event.createdAt}
                    >
                      {new Date(event.createdAt).toLocaleString()}
                    </time>
                  </div>

                  {changes.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {changes.slice(0, isOpen ? changes.length : 3).map(([field, change]) => (
                        <li key={field} className="text-ink-500 dark:text-ink-400">
                          <span className="font-mono">{field}</span>: {renderValue(change.before)}{' '}
                          <span aria-hidden>→</span> {renderValue(change.after)}
                        </li>
                      ))}
                      {!isOpen && changes.length > 3 && (
                        <li className="text-ink-500 dark:text-ink-400">
                          …and {changes.length - 3} more field
                          {changes.length - 3 === 1 ? '' : 's'}
                        </li>
                      )}
                    </ul>
                  )}

                  {/* Override reasons are the thing an auditor looks for, so surface them. */}
                  {typeof event.meta?.overrideReason === 'string' && (
                    <p className="mt-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
                      Override: {event.meta.overrideReason}
                    </p>
                  )}
                  {typeof event.meta?.note === 'string' && event.meta.note && (
                    <p className="mt-1 text-xs text-ink-600 dark:text-ink-300">
                      Note: {event.meta.note}
                    </p>
                  )}

                  {(changes.length > 3 || Object.keys(event.meta ?? {}).length > 0) && (
                    <button
                      type="button"
                      className="mt-1 text-xs text-turf-600 hover:underline"
                      onClick={() => setExpanded(isOpen ? null : event.id)}
                    >
                      {isOpen ? 'Hide detail' : 'Show detail'}
                    </button>
                  )}

                  {isOpen && (
                    <pre className="mt-2 overflow-x-auto rounded bg-ink-100 p-2 text-xs dark:bg-ink-900">
                      {JSON.stringify(event.meta, null, 2)}
                    </pre>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {cursor && (
          <div className="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
            <button
              type="button"
              disabled={loading}
              className={secondaryButtonClass}
              onClick={() => void load(true)}
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </Card>
    </div>
  )
}

/**
 * Per-entity history: "who changed this and when", for the panel on a game detail view.
 * Server-rendered, since the events come down with the page.
 */
export function EntityHistory({
  events,
  timeZone,
}: {
  events: Array<{
    id: string
    action: string
    actorLabel: string
    createdAt: string | Date
    diff: unknown
    meta: unknown
  }>
  /** The entity's own zone — a game's is its venue's. Instants render in it. */
  timeZone?: string | null
}) {
  if (events.length === 0) {
    return <EmptyState>No changes recorded yet.</EmptyState>
  }

  return (
    <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-700">
      {events.map((event) => {
        const changes = Object.entries(
          (event.diff ?? {}) as Record<string, { before: unknown; after: unknown }>,
        )
        const meta = (event.meta ?? {}) as Record<string, unknown>
        return (
          <li key={event.id} className="py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="font-medium">{event.actorLabel}</span>{' '}
                <span className="text-ink-600 dark:text-ink-300">{describeAction(event.action)}</span>
              </span>
              <time className="text-xs text-ink-500 dark:text-ink-400">
                {new Date(event.createdAt).toLocaleString()}
              </time>
            </div>
            {changes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-500 dark:text-ink-400">
                {changes.map(([field, change]) => (
                  <li key={field}>
                    <span className="font-mono">{field}</span>:{' '}
                    {renderValue(change.before, timeZone)} <span aria-hidden>→</span>{' '}
                    {renderValue(change.after, timeZone)}
                  </li>
                ))}
              </ul>
            )}
            {typeof meta.overrideReason === 'string' && (
              <p className="mt-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
                Override: {meta.overrideReason}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
