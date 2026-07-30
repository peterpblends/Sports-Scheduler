import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { SESSION_COOKIE, resolveSession, type Actor } from './session'
import { can, roleIn, type Permission } from './authz'
import type { Role } from '@prisma/client'

/**
 * Server-component counterpart to `getActorFromRequest`. Route handlers use the
 * Request-based path so they stay unit-testable; pages read the same cookie
 * through `next/headers`.
 */
export async function getActor(): Promise<Actor | null> {
  const store = await cookies()
  return resolveSession(store.get(SESSION_COOKIE)?.value ?? null)
}

export async function requireActor(redirectTo?: string): Promise<Actor> {
  const actor = await getActor()
  if (!actor) {
    redirect(redirectTo ? `/login?next=${encodeURIComponent(redirectTo)}` : '/login')
  }
  return actor
}

/**
 * Page-level authorization. Same rules as `requirePermission` for API routes:
 * membership is read fresh from the database, and a non-member sees a 404 rather
 * than a hint that the org exists.
 */
export async function requireOrgAccess(
  orgSlug: string,
  permission: Permission,
): Promise<{ actor: Actor; role: Role; orgId: string; orgName: string }> {
  const actor = await requireActor(`/app/${orgSlug}`)
  const membership = actor.memberships.find((m) => m.orgSlug === orgSlug)
  if (!membership) notFound()
  if (!can(membership.role, permission)) notFound()
  return { actor, role: membership.role, orgId: membership.orgId, orgName: membership.orgName }
}

export { can, roleIn }
