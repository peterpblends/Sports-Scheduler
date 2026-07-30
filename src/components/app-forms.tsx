'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'
import {
  Alert,
  Card,
  EmptyState,
  Label,
  RoleBadge,
  buttonClass,
  dangerButtonClass,
  inputClass,
  secondaryButtonClass,
} from './ui'

const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney',
  'UTC',
]

export function CreateOrgForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const { org } = await api<{ org: { slug: string } }>('/api/orgs', {
        body: { name: form.get('name'), timezone: form.get('timezone') },
      })
      router.push(`/app/${org.slug}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="name">Organization name</Label>
        <input id="name" name="name" required placeholder="Riverside Youth Soccer" className={inputClass} />
      </div>
      <div>
        <Label htmlFor="timezone">Time zone</Label>
        <select id="timezone" name="timezone" defaultValue="America/Los_Angeles" className={inputClass}>
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
          Times are stored in UTC and displayed in the relevant venue&apos;s zone; this is the default for
          the org.
        </p>
      </div>
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
        {busy ? 'Creating…' : 'Create organization'}
      </button>
    </form>
  )
}

export function SignOutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      disabled={busy}
      className="text-sm text-ink-500 hover:underline dark:text-ink-300"
      onClick={async () => {
        setBusy(true)
        await api('/api/auth/logout', { method: 'POST' })
        router.push('/login')
        router.refresh()
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

type Member = {
  id: string
  role: string
  joinedAt: string
  user: { id: string; name: string; email: string }
}
type Invitation = { id: string; email: string; role: string; expiresAt: string }

const ASSIGNABLE = ['owner', 'admin', 'scheduler', 'coach', 'referee', 'viewer'] as const
const INVITABLE = ['admin', 'scheduler', 'coach', 'referee', 'viewer'] as const

export function MembersManager({
  orgId,
  currentUserId,
  canManage,
}: {
  orgId: string
  currentUserId: string
  canManage: boolean
}) {
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      const data = await api<{ members: Member[]; invitations: Invitation[] }>(
        `/api/orgs/${orgId}/members`,
      )
      setMembers(data.members)
      setInvitations(data.invitations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load members.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  async function run(work: () => Promise<string | void>) {
    setError(null)
    setNotice(null)
    try {
      const message = await work()
      if (message) setNotice(message)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    await run(async () => {
      const res = await api<{ acceptUrl?: string }>(`/api/orgs/${orgId}/members`, {
        body: { email: data.get('email'), role: data.get('role') },
      })
      form.reset()
      return res.acceptUrl
        ? `Invitation sent. Dev accept link: ${res.acceptUrl}`
        : 'Invitation sent.'
    })
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {canManage && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">Invite someone</h2>
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Label htmlFor="invite-email">Email</Label>
              <input id="invite-email" name="email" type="email" required className={inputClass} />
            </div>
            <div>
              <Label htmlFor="invite-role">Role</Label>
              <select id="invite-role" name="role" defaultValue="scheduler" className={inputClass}>
                {INVITABLE.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={buttonClass}>
              Send invitation
            </button>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="mb-4 text-base font-semibold">Members</h2>
        {loading ? (
          <EmptyState>Loading…</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Person</th>
                  <th className="pb-2 pr-4 font-medium">Role</th>
                  <th className="pb-2 font-medium">{canManage ? 'Actions' : ''}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 pr-4">
                      <div className="font-medium">
                        {m.user.name}
                        {m.user.id === currentUserId && (
                          <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">(you)</span>
                        )}
                      </div>
                      <div className="text-xs text-ink-500 dark:text-ink-400">{m.user.email}</div>
                    </td>
                    <td className="py-3 pr-4">
                      {canManage ? (
                        <select
                          value={m.role}
                          className={`${inputClass} w-36`}
                          onChange={(e) =>
                            void run(async () => {
                              await api(`/api/orgs/${orgId}/members/${m.id}`, {
                                method: 'PATCH',
                                body: { role: e.target.value },
                              })
                              return 'Role updated.'
                            })
                          }
                        >
                          {ASSIGNABLE.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </td>
                    <td className="py-3">
                      {canManage && (
                        <button
                          type="button"
                          className={dangerButtonClass}
                          onClick={() =>
                            void run(async () => {
                              await api(`/api/orgs/${orgId}/members/${m.id}`, { method: 'DELETE' })
                              return 'Member removed.'
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canManage && (
          <p className="mt-4 text-xs text-ink-500 dark:text-ink-400">
            Your role can view members but not change roles or invite anyone. The server rejects those
            requests regardless of what this page shows.
          </p>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold">Pending invitations</h2>
        {invitations.length === 0 ? (
          <EmptyState>No invitations outstanding.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-700">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <div className="font-medium">{inv.email}</div>
                  <div className="text-xs text-ink-500 dark:text-ink-400">
                    <RoleBadge role={inv.role} /> · expires{' '}
                    {new Date(inv.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                {canManage && (
                  <button
                    type="button"
                    className={dangerButtonClass}
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/invitations/${inv.id}`, { method: 'DELETE' })
                        return 'Invitation revoked.'
                      })
                    }
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

type SessionRow = {
  id: string
  createdAt: string
  lastSeen: string
  expiresAt: string
  userAgent: string | null
  ip: string | null
  current: boolean
}

export function SessionsManager() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      const data = await api<{ sessions: SessionRow[] }>('/api/auth/sessions')
      setSessions(data.sessions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sessions.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">Active sessions</h2>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={async () => {
            await api('/api/auth/sessions', { method: 'DELETE' })
            await load()
          }}
        >
          Sign out everywhere else
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-700">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {s.userAgent ?? 'Unknown device'}
                  {s.current && <span className="ml-2 text-xs text-turf-600">this device</span>}
                </div>
                <div className="text-xs text-ink-500 dark:text-ink-400">
                  last seen {new Date(s.lastSeen).toLocaleString()}
                  {s.ip ? ` · ${s.ip}` : ''}
                </div>
              </div>
              {!s.current && (
                <button
                  type="button"
                  className={dangerButtonClass}
                  onClick={async () => {
                    await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' })
                    await load()
                  }}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await api('/api/auth/password/change', {
        body: { currentPassword: data.get('currentPassword'), newPassword: data.get('newPassword') },
      })
      form.reset()
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-base font-semibold">Change password</h2>
      <form onSubmit={onSubmit} className="max-w-sm space-y-4">
        {error && <Alert>{error}</Alert>}
        {done && <Alert kind="success">Password changed. Other sessions were signed out.</Alert>}
        <div>
          <Label htmlFor="currentPassword">Current password</Label>
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
          />
        </div>
        <div>
          <Label htmlFor="newPassword">New password</Label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            className={inputClass}
          />
        </div>
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </Card>
  )
}
