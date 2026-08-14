'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'
import { Alert, Card, EmptyState, buttonClass, dangerButtonClass, inputClass, secondaryButtonClass } from './ui'

/**
 * Calendar subscriptions and notification preferences — the two things a member
 * controls about how the schedule reaches them.
 */

type Feed = {
  id: string
  scope: 'org' | 'team' | 'referee'
  label: string
  teamName: string | null
  refereeName: string | null
  seasonName: string | null
  createdAt: string
  lastAccessedAt: string | null
}

export function CalendarFeeds({
  orgId,
  feeds,
  teams,
  canSubscribeOrgWide,
  isOfficial,
}: {
  orgId: string
  feeds: Feed[]
  teams: Array<{ id: string; name: string; divisionName: string }>
  canSubscribeOrgWide: boolean
  isOfficial: boolean
}) {
  const router = useRouter()
  const [scope, setScope] = useState<'org' | 'team' | 'referee'>(
    canSubscribeOrgWide ? 'org' : isOfficial ? 'referee' : 'team',
  )
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const [created, setCreated] = useState<{ label: string; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const data = await api<{ feed: { label: string }; url: string }>(
        `/api/orgs/${orgId}/feeds`,
        { method: 'POST', body: { scope, ...(scope === 'team' ? { teamId } : {}) } },
      )
      setCreated({ label: data.feed.label, url: data.url })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that subscription.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/orgs/${orgId}/feeds/${id}`, { method: 'DELETE' })
      setCreated(null)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke that subscription.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold">Calendar subscriptions</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        A live feed URL you paste into Google Calendar, Apple Calendar or Outlook. It updates
        itself, shows the published schedule only, and stops working if you leave this
        organization.
      </p>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {created && (
        <div className="mt-4 rounded-lg border border-turf-500/50 bg-turf-500/10 p-3">
          <p className="text-sm font-medium">{created.label} — copy this now</p>
          <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">
            This is the only time the URL is shown. It is a password: anyone who has it can read
            the feed. If you lose it, revoke the subscription and make another.
          </p>
          <input
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className={`${inputClass} mt-2 font-mono text-xs`}
          />
        </div>
      )}

      {feeds.length === 0 ? (
        <div className="mt-4">
          <EmptyState>No subscriptions yet.</EmptyState>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-ink-200 text-sm dark:divide-ink-700">
          {feeds.map((feed) => (
            <li key={feed.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{feed.label}</span>
                <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                  {feed.scope}
                  {feed.seasonName && ` · ${feed.seasonName}`}
                  {' · '}
                  {feed.lastAccessedAt
                    ? `last fetched ${new Date(feed.lastAccessedAt).toLocaleString()}`
                    : 'never fetched'}
                </span>
              </span>
              <button
                type="button"
                className={dangerButtonClass}
                disabled={busy}
                onClick={() => void revoke(feed.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-ink-200 pt-4 dark:border-ink-700">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">What to subscribe to</span>
          <select
            className={inputClass}
            value={scope}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            {canSubscribeOrgWide && <option value="org">Every fixture</option>}
            {teams.length > 0 && <option value="team">One team&apos;s fixtures</option>}
            {isOfficial && <option value="referee">My officiating assignments</option>}
          </select>
        </label>

        {scope === 'team' && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Team</span>
            <select
              className={inputClass}
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.divisionName} · {team.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          className={buttonClass}
          disabled={busy || (scope === 'team' && !teamId)}
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : 'Create a subscription URL'}
        </button>
      </div>
    </Card>
  )
}

type Kind = string

export function NotificationPreferences({
  orgId,
  initial,
  labels,
}: {
  orgId: string
  initial: Record<Kind, boolean>
  labels: Record<Kind, { title: string; detail: string }>
}) {
  // Rendered from the labels the server sent rather than a list repeated here, so a
  // new notification kind shows up without a second edit in this file.
  const KINDS = Object.keys(labels)
  const [prefs, setPrefs] = useState(initial)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function toggle(kind: Kind, value: boolean) {
    // Optimistic, then reconciled from the response — a checkbox that lags a round trip
    // feels broken.
    const previous = prefs
    setPrefs({ ...prefs, [kind]: value })
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const data = await api<{ preferences: Record<Kind, boolean> }>(
        `/api/orgs/${orgId}/notifications`,
        { method: 'PATCH', body: { [kind]: value } },
      )
      setPrefs(data.preferences)
      setNote('Saved.')
    } catch (err) {
      setPrefs(previous)
      setError(err instanceof Error ? err.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold">Email notifications</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        For this organization only. You are only ever emailed about things you are actually
        involved in.
      </p>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {note && !error && (
        <div className="mt-4">
          <Alert kind="success">{note}</Alert>
        </div>
      )}

      <ul className="mt-4 divide-y divide-ink-200 dark:divide-ink-700">
        {KINDS.map((kind) => (
          <li key={kind} className="py-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-turf-600"
                checked={prefs[kind]}
                disabled={busy}
                onChange={(event) => void toggle(kind, event.target.checked)}
              />
              <span>
                <span className="text-sm font-medium">{labels[kind].title}</span>
                <span className="block text-sm text-ink-500 dark:text-ink-300">
                  {labels[kind].detail}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function ExportLinks({
  scheduleHref,
  assignmentsHref,
  printHref,
}: {
  scheduleHref: string
  assignmentsHref: string | null
  printHref: string
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold">One-off exports</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        A snapshot rather than a live feed. CSV columns match what the roster importer reads, so
        a file can be edited and imported back.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={scheduleHref} className={secondaryButtonClass}>
          Schedule CSV
        </a>
        {assignmentsHref && (
          <a href={assignmentsHref} className={secondaryButtonClass}>
            Officiating CSV
          </a>
        )}
        <a href={printHref} className={secondaryButtonClass}>
          Printable schedule
        </a>
      </div>
    </Card>
  )
}
