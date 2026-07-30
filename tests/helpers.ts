import { prisma } from '@/lib/prisma'
import { SESSION_COOKIE } from '@/lib/session'
import { setMailer, type Mail, type Mailer } from '@/lib/mailer'

const BASE = 'http://localhost:3000'

export type RouteHandler<Ctx = unknown> = (req: Request, ctx: Ctx) => Promise<Response>

export type CallOptions<P> = {
  method?: string
  body?: unknown
  /** Raw session token; sent as the session cookie. */
  token?: string | null
  params?: P
  headers?: Record<string, string>
  query?: Record<string, string>
}

/**
 * Invokes a route handler the same way Next would, but without a server: a real
 * `Request` in, a real `Response` out. Every authorization path in the app is
 * therefore exercised exactly as deployed.
 */
export async function call<P = unknown>(
  handler: RouteHandler<{ params: Promise<P> }>,
  path: string,
  options: CallOptions<P> = {},
): Promise<{ status: number; body: any; setCookie: string | null; res: Response }> {
  const url = new URL(path, BASE)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value)
  }

  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  if (options.token) headers.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(options.token)}`)

  const req = new Request(url, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  const res = await handler(req, { params: Promise.resolve(options.params as P) })
  const text = await res.text()

  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    setCookie: res.headers.get('set-cookie'),
    res,
  }
}

/** Pulls the session token back out of a Set-Cookie header. */
export function tokenFromSetCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error('Expected a Set-Cookie header.')
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(setCookie)
  if (!match || !match[1]) throw new Error(`No ${SESSION_COOKIE} in: ${setCookie}`)
  return decodeURIComponent(match[1])
}

// ---------------------------------------------------------------------------
// Mail capture
// ---------------------------------------------------------------------------

export class CapturingMailer implements Mailer {
  readonly sent: Mail[] = []

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail)
  }

  last(): Mail {
    const mail = this.sent.at(-1)
    if (!mail) throw new Error('No mail was sent.')
    return mail
  }

  /** First URL in the most recent message — the reset or invite link. */
  lastLink(): string {
    const match = /https?:\/\/\S+/.exec(this.last().text)
    if (!match) throw new Error(`No link in mail body: ${this.last().text}`)
    return match[0]
  }

  tokenFromLastLink(): string {
    const token = new URL(this.lastLink()).searchParams.get('token')
    if (!token) throw new Error(`No token in link: ${this.lastLink()}`)
    return token
  }
}

export function useCapturingMailer(): CapturingMailer {
  const mailer = new CapturingMailer()
  setMailer(mailer)
  return mailer
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Wipes every table. Audit rows are append-only in the app, not in test setup. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditEvent", "Invitation", "PasswordResetToken", "Session",
                   "Membership", "Organization", "User"
    RESTART IDENTITY CASCADE
  `)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { POST as signup } from '@/app/api/auth/signup/route'
import { POST as createOrg } from '@/app/api/orgs/route'
import { POST as invite } from '@/app/api/orgs/[orgId]/members/route'
import { POST as acceptInvite } from '@/app/api/invitations/accept/route'
import type { Role } from '@prisma/client'

export type TestUser = { id: string; email: string; token: string }

export async function signUp(
  email: string,
  password = 'correct-horse-battery',
  name = email.split('@')[0]!,
): Promise<TestUser> {
  const res = await call(signup, '/api/auth/signup', { body: { name, email, password } })
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`)
  return { id: res.body.user.id, email: res.body.user.email, token: tokenFromSetCookie(res.setCookie) }
}

export async function createOrganization(
  owner: TestUser,
  name = 'Riverside Youth Soccer',
): Promise<{ id: string; slug: string }> {
  const res = await call(createOrg, '/api/orgs', {
    token: owner.token,
    body: { name, timezone: 'America/Los_Angeles' },
  })
  if (res.status !== 201) throw new Error(`org create failed: ${JSON.stringify(res.body)}`)
  return { id: res.body.org.id, slug: res.body.org.slug }
}

/**
 * Full invite round trip: an admin invites `email` at `role`, the invitee accepts
 * with a brand-new account, and the resulting session token comes back.
 */
export async function inviteAndAccept(
  inviter: TestUser,
  orgId: string,
  email: string,
  role: Exclude<Role, 'owner'>,
  mailer: CapturingMailer,
): Promise<TestUser> {
  const inviteRes = await call<{ orgId: string }>(invite, `/api/orgs/${orgId}/members`, {
    token: inviter.token,
    params: { orgId },
    body: { email, role },
  })
  if (inviteRes.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inviteRes.body)}`)

  const token = mailer.tokenFromLastLink()
  const acceptRes = await call(acceptInvite, '/api/invitations/accept', {
    body: { token, name: email.split('@')[0], password: 'correct-horse-battery' },
  })
  if (acceptRes.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acceptRes.body)}`)

  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return { id: user.id, email, token: tokenFromSetCookie(acceptRes.setCookie) }
}

export async function membershipIdFor(orgId: string, userId: string): Promise<string> {
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_orgId: { userId, orgId } },
  })
  return membership.id
}
