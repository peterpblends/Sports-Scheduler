'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'
import { safeRedirectPath } from '@/lib/redirect'
import { Alert, Label, buttonClass, inputClass } from './ui'

function useSubmit(action: (form: FormData) => Promise<void>) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await action(new FormData(event.currentTarget))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return { error, busy, onSubmit }
}

export function SignupForm() {
  const router = useRouter()
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api('/api/auth/signup', {
      body: {
        name: form.get('name'),
        email: form.get('email'),
        password: form.get('password'),
      },
    })
    router.push('/app')
  })

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="name">Your name</Label>
        <input id="name" name="name" required autoComplete="name" className={inputClass} />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <input id="email" name="email" type="email" required autoComplete="email" className={inputClass} />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">At least 10 characters.</p>
      </div>
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  )
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter()
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api('/api/auth/login', {
      body: { email: form.get('email'), password: form.get('password') },
    })
    // Same validation as the server page, from the same helper — a lenient copy
    // here would reopen the redirect the server closed.
    router.push(safeRedirectPath(next))
  })

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="email">Email</Label>
        <input id="email" name="email" type="email" required autoComplete="email" className={inputClass} />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false)
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api('/api/auth/password/forgot', { body: { email: form.get('email') } })
    setSent(true)
  })

  if (sent) {
    return (
      <Alert kind="success">
        If an account exists for that address, a reset link is on its way. The link is good for one hour.
      </Alert>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="email">Email</Label>
        <input id="email" name="email" type="email" required autoComplete="email" className={inputClass} />
      </div>
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  )
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api('/api/auth/password/reset', { body: { token, password: form.get('password') } })
    router.push('/app')
  })

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="password">New password</Label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
          At least 10 characters. Signing in again elsewhere will be required.
        </p>
      </div>
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
        {busy ? 'Saving…' : 'Set new password'}
      </button>
    </form>
  )
}

type InvitePreview = {
  email: string
  role: string
  orgName: string
  hasAccount: boolean
}

export function AcceptInviteForm({
  token,
  invitation,
  signedInAs,
}: {
  token: string
  invitation: InvitePreview
  signedInAs: string | null
}) {
  const router = useRouter()
  const needsAccount = !invitation.hasAccount && !signedInAs
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api('/api/invitations/accept', {
      body: needsAccount
        ? { token, name: form.get('name'), password: form.get('password') }
        : { token },
    })
    router.push('/app')
  })

  const wrongAccount = signedInAs !== null && signedInAs !== invitation.email

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}

      <Alert kind="info">
        You have been invited to <strong>{invitation.orgName}</strong> as{' '}
        <strong>{invitation.role}</strong>, for {invitation.email}.
      </Alert>

      {wrongAccount && (
        <Alert>
          You are signed in as {signedInAs}. Sign out and reopen this link to accept as{' '}
          {invitation.email}.
        </Alert>
      )}

      {invitation.hasAccount && !signedInAs && (
        <Alert kind="info">
          That address already has an account. <a className="underline" href="/login">Sign in</a>, then
          reopen this link.
        </Alert>
      )}

      {needsAccount && (
        <>
          <div>
            <Label htmlFor="name">Your name</Label>
            <input id="name" name="name" required autoComplete="name" className={inputClass} />
          </div>
          <div>
            <Label htmlFor="password">Choose a password</Label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
        </>
      )}

      <button
        type="submit"
        disabled={busy || wrongAccount || (invitation.hasAccount && !signedInAs)}
        className={`${buttonClass} w-full`}
      >
        {busy ? 'Joining…' : `Join ${invitation.orgName}`}
      </button>
    </form>
  )
}
