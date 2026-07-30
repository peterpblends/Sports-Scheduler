import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import { resolveSession } from '@/lib/session'
import {
  CapturingMailer,
  call,
  resetDatabase,
  signUp,
  tokenFromSetCookie,
  useCapturingMailer,
} from './helpers'

import { POST as signup } from '@/app/api/auth/signup/route'
import { POST as login } from '@/app/api/auth/login/route'
import { POST as logout } from '@/app/api/auth/logout/route'
import { POST as forgotPassword } from '@/app/api/auth/password/forgot/route'
import { POST as resetPassword } from '@/app/api/auth/password/reset/route'
import { POST as changePassword } from '@/app/api/auth/password/change/route'
import { GET as listSessions, DELETE as revokeOthers } from '@/app/api/auth/sessions/route'
import { DELETE as revokeOne } from '@/app/api/auth/sessions/[sessionId]/route'

let mailer: CapturingMailer

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()
})

describe('signup', () => {
  it('creates a user, hashes the password, and issues a session', async () => {
    const res = await call(signup, '/api/auth/signup', {
      body: { name: 'Dana Ortiz', email: 'Dana@Example.com', password: 'correct-horse-battery' },
    })

    expect(res.status).toBe(201)
    expect(res.body.user.email).toBe('dana@example.com') // normalized
    expect(res.setCookie).toContain('HttpOnly')
    expect(res.setCookie).toContain('SameSite=Lax')

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'dana@example.com' } })
    expect(user.passwordHash).not.toContain('correct-horse-battery')
    expect(user.passwordHash.startsWith('$argon2')).toBe(true)

    const actor = await resolveSession(tokenFromSetCookie(res.setCookie))
    expect(actor?.userId).toBe(user.id)
  })

  it('stores only a hash of the session token', async () => {
    const user = await signUp('hash@example.com')
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } })
    expect(session.tokenHash).not.toBe(user.token)
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a duplicate email and a weak password', async () => {
    await signUp('dupe@example.com')

    const dupe = await call(signup, '/api/auth/signup', {
      body: { name: 'Other', email: 'dupe@example.com', password: 'correct-horse-battery' },
    })
    expect(dupe.status).toBe(409)

    const weak = await call(signup, '/api/auth/signup', {
      body: { name: 'Short', email: 'short@example.com', password: 'abc' },
    })
    expect(weak.status).toBe(400)
  })
})

describe('login', () => {
  it('accepts the right password and rejects the wrong one with the same message', async () => {
    await signUp('login@example.com', 'correct-horse-battery')

    const good = await call(login, '/api/auth/login', {
      body: { email: 'login@example.com', password: 'correct-horse-battery' },
    })
    expect(good.status).toBe(200)
    expect(await resolveSession(tokenFromSetCookie(good.setCookie))).not.toBeNull()

    const wrongPassword = await call(login, '/api/auth/login', {
      body: { email: 'login@example.com', password: 'not-the-password' },
    })
    const noSuchUser = await call(login, '/api/auth/login', {
      body: { email: 'nobody@example.com', password: 'not-the-password' },
    })

    expect(wrongPassword.status).toBe(401)
    expect(noSuchUser.status).toBe(401)
    // Identical wording: the endpoint must not reveal which accounts exist.
    expect(wrongPassword.body.error).toBe(noSuchUser.body.error)
  })
})

describe('logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const user = await signUp('bye@example.com')

    const res = await call(logout, '/api/auth/logout', { method: 'POST', token: user.token })
    expect(res.status).toBe(200)
    expect(res.setCookie).toContain('Expires=Thu, 01 Jan 1970')

    expect(await resolveSession(user.token)).toBeNull()
  })
})

describe('password reset', () => {
  it('emails a single-use link that sets a new password and kills old sessions', async () => {
    const user = await signUp('reset@example.com', 'original-password-1')

    const forgot = await call(forgotPassword, '/api/auth/password/forgot', {
      body: { email: 'reset@example.com' },
    })
    expect(forgot.status).toBe(200)
    const token = mailer.tokenFromLastLink()

    const reset = await call(resetPassword, '/api/auth/password/reset', {
      body: { token, password: 'brand-new-password-2' },
    })
    expect(reset.status).toBe(200)

    // Old session is dead, new one works, old password no longer valid.
    expect(await resolveSession(user.token)).toBeNull()
    expect(await resolveSession(tokenFromSetCookie(reset.setCookie))).not.toBeNull()

    const oldPassword = await call(login, '/api/auth/login', {
      body: { email: 'reset@example.com', password: 'original-password-1' },
    })
    expect(oldPassword.status).toBe(401)

    const newPassword = await call(login, '/api/auth/login', {
      body: { email: 'reset@example.com', password: 'brand-new-password-2' },
    })
    expect(newPassword.status).toBe(200)

    // Replaying the same link fails.
    const replay = await call(resetPassword, '/api/auth/password/reset', {
      body: { token, password: 'third-password-333' },
    })
    expect(replay.status).toBe(400)
  })

  it('does not reveal whether an address has an account', async () => {
    const res = await call(forgotPassword, '/api/auth/password/forgot', {
      body: { email: 'ghost@example.com' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(0)
  })

  it('invalidates an earlier outstanding link when a new one is requested', async () => {
    await signUp('twice@example.com')

    await call(forgotPassword, '/api/auth/password/forgot', { body: { email: 'twice@example.com' } })
    const firstToken = mailer.tokenFromLastLink()

    await call(forgotPassword, '/api/auth/password/forgot', { body: { email: 'twice@example.com' } })
    const secondToken = mailer.tokenFromLastLink()

    expect(firstToken).not.toBe(secondToken)

    const stale = await call(resetPassword, '/api/auth/password/reset', {
      body: { token: firstToken, password: 'password-from-stale' },
    })
    expect(stale.status).toBe(400)

    const fresh = await call(resetPassword, '/api/auth/password/reset', {
      body: { token: secondToken, password: 'password-from-fresh' },
    })
    expect(fresh.status).toBe(200)
  })

  it('stores reset tokens hashed', async () => {
    await signUp('hashed@example.com')
    await call(forgotPassword, '/api/auth/password/forgot', { body: { email: 'hashed@example.com' } })
    const raw = mailer.tokenFromLastLink()
    const record = await prisma.passwordResetToken.findFirstOrThrow()
    expect(record.tokenHash).not.toBe(raw)
  })
})

describe('password change', () => {
  it('requires the current password and rotates sessions', async () => {
    const user = await signUp('change@example.com', 'original-password-1')

    const wrong = await call(changePassword, '/api/auth/password/change', {
      token: user.token,
      body: { currentPassword: 'nope-nope-nope', newPassword: 'second-password-22' },
    })
    expect(wrong.status).toBe(400)

    const ok = await call(changePassword, '/api/auth/password/change', {
      token: user.token,
      body: { currentPassword: 'original-password-1', newPassword: 'second-password-22' },
    })
    expect(ok.status).toBe(200)

    expect(await resolveSession(user.token)).toBeNull()
    expect(await resolveSession(tokenFromSetCookie(ok.setCookie))).not.toBeNull()
  })

  it('requires a session', async () => {
    const res = await call(changePassword, '/api/auth/password/change', {
      body: { currentPassword: 'x', newPassword: 'second-password-22' },
    })
    expect(res.status).toBe(401)
  })
})

describe('session management', () => {
  it('lists a user’s own sessions and marks the current one', async () => {
    const user = await signUp('sessions@example.com')
    await call(login, '/api/auth/login', {
      body: { email: 'sessions@example.com', password: 'correct-horse-battery' },
    })

    const res = await call(listSessions, '/api/auth/sessions', { token: user.token })
    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(2)
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
  })

  it('revokes other sessions but keeps the current one', async () => {
    const user = await signUp('revoke@example.com')
    const second = await call(login, '/api/auth/login', {
      body: { email: 'revoke@example.com', password: 'correct-horse-battery' },
    })
    const secondToken = tokenFromSetCookie(second.setCookie)

    const res = await call(revokeOthers, '/api/auth/sessions', { method: 'DELETE', token: user.token })
    expect(res.status).toBe(200)
    expect(res.body.revoked).toBe(1)

    expect(await resolveSession(user.token)).not.toBeNull()
    expect(await resolveSession(secondToken)).toBeNull()
  })

  it('cannot revoke another user’s session', async () => {
    const alice = await signUp('alice@example.com')
    const bob = await signUp('bob@example.com')
    const bobSession = await prisma.session.findFirstOrThrow({ where: { userId: bob.id } })

    const res = await call<{ sessionId: string }>(revokeOne, `/api/auth/sessions/${bobSession.id}`, {
      method: 'DELETE',
      token: alice.token,
      params: { sessionId: bobSession.id },
    })

    expect(res.status).toBe(404)
    expect(await resolveSession(bob.token)).not.toBeNull()
  })
})

describe('session validity', () => {
  it('rejects an expired session', async () => {
    const user = await signUp('expired@example.com')
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await resolveSession(user.token)).toBeNull()
  })

  it('rejects a session for a soft-deleted user', async () => {
    const user = await signUp('gone@example.com')
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } })
    expect(await resolveSession(user.token)).toBeNull()
  })

  it('rejects a garbage token', async () => {
    expect(await resolveSession('not-a-real-token')).toBeNull()
    expect(await resolveSession('')).toBeNull()
    expect(await resolveSession(null)).toBeNull()
  })
})
