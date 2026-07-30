import { prisma } from './prisma'
import { generateToken, hashToken } from './tokens'
import type { Role } from '@prisma/client'

export const SESSION_COOKIE = 'ss_session'

function ttlDays(): number {
  const raw = Number(process.env.SESSION_TTL_DAYS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30
}

export type Actor = {
  userId: string
  email: string
  name: string
  sessionId: string
  memberships: { orgId: string; orgName: string; orgSlug: string; role: Role }[]
}

// ---------------------------------------------------------------------------
// Cookie plumbing
//
// Session cookies are read off a plain `Request` and written onto a plain
// `Response` rather than through `next/headers`. That keeps every route handler
// a pure function of Request -> Response, so the whole auth surface is callable
// from tests without booting Next.
// ---------------------------------------------------------------------------

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return null
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ]
  if (process.env.NODE_ENV === 'production') attrs.push('Secure')
  return attrs.join('; ')
}

export function clearedSessionCookie(): string {
  const attrs = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ]
  if (process.env.NODE_ENV === 'production') attrs.push('Secure')
  return attrs.join('; ')
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + ttlDays() * 24 * 60 * 60 * 1000)
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      ip: meta.ip ?? null,
    },
  })
  return { token, expiresAt }
}

/** Resolves a raw session token to an actor, or null if it is invalid in any way. */
export async function resolveSession(token: string | null): Promise<Actor | null> {
  if (!token) return null

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        include: {
          memberships: {
            where: { deletedAt: null, org: { deletedAt: null } },
            include: { org: true },
          },
        },
      },
    },
  })

  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt.getTime() <= Date.now()) return null
  if (session.user.deletedAt) return null
  // A password change bumps sessionsValidFrom, retiring every older session.
  if (session.createdAt.getTime() < session.user.sessionsValidFrom.getTime()) return null

  return {
    userId: session.userId,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.id,
    memberships: session.user.memberships.map((m) => ({
      orgId: m.orgId,
      orgName: m.org.name,
      orgSlug: m.org.slug,
      role: m.role,
    })),
  }
}

export async function getActorFromRequest(req: Request): Promise<Actor | null> {
  return resolveSession(readCookie(req.headers.get('cookie'), SESSION_COOKIE))
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  })
  return result.count
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { lastSeen: new Date() } })
}
