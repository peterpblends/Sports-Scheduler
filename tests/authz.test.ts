import { describe, expect, it } from 'vitest'
import { ROLES, can, canAssignRole, canRemoveMember, rank } from '@/lib/authz'

describe('permission matrix', () => {
  it('gives owner everything admin has, plus billing and deletion', () => {
    for (const permission of ['org:delete', 'org:billing'] as const) {
      expect(can('owner', permission)).toBe(true)
      expect(can('admin', permission)).toBe(false)
    }
    expect(can('owner', 'schedule:publish')).toBe(true)
  })

  it('lets scheduler run schedules but never touch members or roles', () => {
    expect(can('scheduler', 'schedule:generate')).toBe(true)
    expect(can('scheduler', 'schedule:edit')).toBe(true)
    expect(can('scheduler', 'schedule:publish')).toBe(true)
    expect(can('scheduler', 'official:assign')).toBe(true)

    expect(can('scheduler', 'member:invite')).toBe(false)
    expect(can('scheduler', 'member:update_role')).toBe(false)
    expect(can('scheduler', 'member:remove')).toBe(false)
    expect(can('scheduler', 'org:update')).toBe(false)
    expect(can('scheduler', 'roster:write')).toBe(false)
  })

  it('limits coach to reads plus own-team writes and reschedule requests', () => {
    expect(can('coach', 'schedule:read:published')).toBe(true)
    expect(can('coach', 'reschedule:request:own')).toBe(true)
    expect(can('coach', 'roster:write:own')).toBe(true)

    expect(can('coach', 'roster:write')).toBe(false)
    expect(can('coach', 'schedule:edit')).toBe(false)
    expect(can('coach', 'schedule:generate')).toBe(false)
    expect(can('coach', 'official:assign')).toBe(false)
    expect(can('coach', 'member:invite')).toBe(false)
  })

  it('limits referee to their own assignments and availability', () => {
    expect(can('referee', 'official:read:own')).toBe(true)
    expect(can('referee', 'official:availability:write:own')).toBe(true)
    expect(can('referee', 'official:respond:own')).toBe(true)

    expect(can('referee', 'official:read')).toBe(false)
    expect(can('referee', 'official:assign')).toBe(false)
    expect(can('referee', 'roster:read')).toBe(false)
    expect(can('referee', 'schedule:edit')).toBe(false)
  })

  it('gives viewer no write permission at all', () => {
    const writes = [...(['org:update', 'member:invite', 'roster:write', 'venue:write',
      'schedule:edit', 'schedule:generate', 'schedule:publish', 'official:assign'] as const)]
    for (const permission of writes) expect(can('viewer', permission)).toBe(false)
    expect(can('viewer', 'schedule:read:published')).toBe(true)
  })

  it('never grants an unpublished schedule read to coach, referee or viewer', () => {
    for (const role of ['coach', 'referee', 'viewer'] as const) {
      expect(can(role, 'schedule:read')).toBe(false)
    }
    for (const role of ['owner', 'admin', 'scheduler'] as const) {
      expect(can(role, 'schedule:read')).toBe(true)
    }
  })
})

describe('role assignment rules', () => {
  it('lets only an owner grant or revoke ownership', () => {
    expect(canAssignRole('owner', 'admin', 'owner')).toBe(true)
    expect(canAssignRole('owner', 'owner', 'admin')).toBe(true)

    expect(canAssignRole('admin', 'admin', 'owner')).toBe(false)
    expect(canAssignRole('admin', 'owner', 'viewer')).toBe(false)
  })

  it('refuses to grant a role above the actor’s own rank', () => {
    expect(canAssignRole('admin', 'viewer', 'admin')).toBe(true)
    expect(canAssignRole('admin', 'viewer', 'owner')).toBe(false)
    expect(rank('owner')).toBeGreaterThan(rank('admin'))
    expect(rank('admin')).toBeGreaterThan(rank('scheduler'))
    expect(rank('scheduler')).toBeGreaterThan(rank('viewer'))
  })

  it('refuses every role change and removal for roles without member permissions', () => {
    for (const actorRole of ['scheduler', 'coach', 'referee', 'viewer'] as const) {
      for (const target of ROLES) {
        expect(canAssignRole(actorRole, target, 'viewer')).toBe(false)
        expect(canRemoveMember(actorRole, target)).toBe(false)
      }
    }
  })

  it('stops an admin from removing an owner', () => {
    expect(canRemoveMember('admin', 'owner')).toBe(false)
    expect(canRemoveMember('admin', 'scheduler')).toBe(true)
    expect(canRemoveMember('owner', 'owner')).toBe(true)
  })
})
