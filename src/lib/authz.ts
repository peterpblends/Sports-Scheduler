import type { Role } from '@prisma/client'
import type { Actor } from './session'

export const ROLES = ['owner', 'admin', 'scheduler', 'coach', 'referee', 'viewer'] as const

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  scheduler: 'Scheduler',
  coach: 'Coach',
  referee: 'Referee',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the organization.',
  admin: 'Full schedule and roster control.',
  scheduler: 'Generate and edit schedules. Cannot change members or roles.',
  coach: 'Read-only, plus reschedule requests and roster edits for their own team.',
  referee:
    'Sees only their own assignments; sets availability, accepts or declines, and can ask for games that are short an official.',
  viewer: 'Read-only.',
}

/**
 * Permissions are named `<subject>:<verb>` and, where a permission only applies to
 * rows the actor is attached to, suffixed `:own`. A `:own` permission always
 * requires a second, scope-level check — see `assertScope` callers in phase 2.
 */
export type Permission =
  // organization
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  | 'org:billing'
  // membership
  | 'member:read'
  | 'member:invite'
  | 'member:update_role'
  | 'member:remove'
  // structure (leagues, seasons, divisions)
  | 'structure:read'
  | 'structure:write'
  // rosters (teams, people, memberships)
  | 'roster:read'
  | 'roster:write'
  | 'roster:write:own'
  // venues, fields, time slots, blackouts
  | 'venue:read'
  | 'venue:write'
  // schedules and games
  | 'schedule:read'
  | 'schedule:read:published'
  | 'schedule:generate'
  | 'schedule:edit'
  | 'schedule:publish'
  | 'schedule:restore'
  | 'reschedule:request:own'
  // officials
  | 'official:read'
  | 'official:read:own'
  | 'official:assign'
  | 'official:availability:write'
  | 'official:availability:write:own'
  | 'official:respond:own'
  /** Ask to officiate a game that is short an official. Referee only. */
  | 'official:request:own'
  /** Approve or reject those requests. Never held by the referee making them. */
  | 'official:request:review'
  // history
  | 'audit:read'

const OWNER_ONLY: Permission[] = ['org:delete', 'org:billing']

const ADMIN: Permission[] = [
  'org:read',
  'org:update',
  'member:read',
  'member:invite',
  'member:update_role',
  'member:remove',
  'structure:read',
  'structure:write',
  'roster:read',
  'roster:write',
  'venue:read',
  'venue:write',
  'schedule:read',
  'schedule:read:published',
  'schedule:generate',
  'schedule:edit',
  'schedule:publish',
  'schedule:restore',
  'official:read',
  'official:assign',
  'official:availability:write',
  'official:request:review',
  'audit:read',
]

const SCHEDULER: Permission[] = [
  'org:read',
  'member:read',
  'structure:read',
  'roster:read',
  'venue:read',
  'venue:write',
  'schedule:read',
  'schedule:read:published',
  'schedule:generate',
  'schedule:edit',
  'schedule:publish',
  'schedule:restore',
  'official:read',
  'official:assign',
  'official:request:review',
  'audit:read',
]

const COACH: Permission[] = [
  'org:read',
  'structure:read',
  'roster:read',
  'roster:write:own',
  'venue:read',
  'schedule:read:published',
  'reschedule:request:own',
]

const REFEREE: Permission[] = [
  'org:read',
  'schedule:read:published',
  'venue:read',
  'official:read:own',
  'official:availability:write:own',
  'official:respond:own',
  // Ask, but never decide. `official:request:review` is deliberately absent, so a
  // referee cannot approve their own request even though they can create it.
  'official:request:own',
]

const VIEWER: Permission[] = [
  'org:read',
  'structure:read',
  'roster:read',
  'venue:read',
  'schedule:read:published',
]

export const PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([...ADMIN, ...OWNER_ONLY]),
  admin: new Set<Permission>(ADMIN),
  scheduler: new Set<Permission>(SCHEDULER),
  coach: new Set<Permission>(COACH),
  referee: new Set<Permission>(REFEREE),
  viewer: new Set<Permission>(VIEWER),
}

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].has(permission)
}

/** Higher number = more authority. Used to stop privilege escalation. */
export function rank(role: Role): number {
  switch (role) {
    case 'owner':
      return 50
    case 'admin':
      return 40
    case 'scheduler':
      return 30
    case 'coach':
      return 20
    case 'referee':
      return 20
    case 'viewer':
      return 10
  }
}

export function roleIn(actor: Actor, orgId: string): Role | null {
  return actor.memberships.find((m) => m.orgId === orgId)?.role ?? null
}

/**
 * Whether `actorRole` may move some member from `fromRole` to `toRole`.
 *
 * Rules, in addition to holding `member:update_role`:
 *  - only an owner may grant or revoke `owner`
 *  - nobody may act on a member whose role outranks their own
 *  - nobody may grant a role above their own
 */
export function canAssignRole(actorRole: Role, fromRole: Role, toRole: Role): boolean {
  if (!can(actorRole, 'member:update_role')) return false
  if ((toRole === 'owner' || fromRole === 'owner') && actorRole !== 'owner') return false
  if (rank(fromRole) > rank(actorRole)) return false
  if (rank(toRole) > rank(actorRole)) return false
  return true
}

export function canRemoveMember(actorRole: Role, targetRole: Role): boolean {
  if (!can(actorRole, 'member:remove')) return false
  if (targetRole === 'owner' && actorRole !== 'owner') return false
  if (rank(targetRole) > rank(actorRole)) return false
  return true
}
