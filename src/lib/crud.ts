import { prisma } from './prisma'
import { conflict, notFound } from './http'
import { diffRecords, recordAudit } from './audit'
import type { Actor } from './session'
import type { Prisma } from '@prisma/client'

/**
 * Shared mutation plumbing: run the write and its audit event in one
 * transaction, so a committed change always has its history and a rolled-back
 * one leaves none.
 *
 * Each route still spells out its own permission check and org scoping — those
 * are the parts that must be readable per endpoint, so they are deliberately not
 * hidden in here.
 */

type Snapshot = Record<string, unknown>

export async function createWithAudit<T>(opts: {
  orgId: string
  actor: Actor
  entityType: string
  action?: string
  create: (tx: Prisma.TransactionClient) => Promise<T>
  snapshot: (row: T) => Snapshot
  id: (row: T) => string
  meta?: Record<string, unknown>
}): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const row = await opts.create(tx)
    const after = opts.snapshot(row)
    await recordAudit(
      {
        orgId: opts.orgId,
        actorId: opts.actor.userId,
        actorLabel: opts.actor.email,
        entityType: opts.entityType,
        entityId: opts.id(row),
        action: opts.action ?? `${opts.entityType.toLowerCase()}.created`,
        diff: diffRecords(null, after),
        meta: opts.meta,
      },
      tx,
    )
    return row
  })
}

export async function updateWithAudit<T>(opts: {
  orgId: string
  actor: Actor
  entityType: string
  entityId: string
  action?: string
  before: Snapshot
  update: (tx: Prisma.TransactionClient) => Promise<T>
  snapshot: (row: T) => Snapshot
  meta?: Record<string, unknown>
}): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const row = await opts.update(tx)
    const diff = diffRecords(opts.before, opts.snapshot(row))
    // A no-op PATCH records nothing — the audit log tracks changes, not requests.
    if (Object.keys(diff).length > 0) {
      await recordAudit(
        {
          orgId: opts.orgId,
          actorId: opts.actor.userId,
          actorLabel: opts.actor.email,
          entityType: opts.entityType,
          entityId: opts.entityId,
          action: opts.action ?? `${opts.entityType.toLowerCase()}.updated`,
          diff,
          meta: opts.meta,
        },
        tx,
      )
    }
    return row
  })
}

/**
 * Soft delete. Never a DELETE — a row's history has to stay reachable, which is
 * non-negotiable #2.
 *
 * `softDelete` receives the transaction and must stamp `deletedAt` on exactly the
 * intended row, returning how many rows it touched. Zero means the row was
 * already gone, which is a 404 and rolls the transaction back, so no audit event
 * is written for a delete that did not happen.
 */
export async function softDeleteWithAudit(opts: {
  orgId: string
  actor: Actor
  entityType: string
  entityId: string
  action?: string
  softDelete: (tx: Prisma.TransactionClient, deletedAt: Date) => Promise<{ count: number }>
  meta?: Record<string, unknown>
}): Promise<void> {
  const deletedAt = new Date()
  await prisma.$transaction(async (tx) => {
    const result = await opts.softDelete(tx, deletedAt)
    if (result.count === 0) throw notFound(`${opts.entityType} not found.`)

    await recordAudit(
      {
        orgId: opts.orgId,
        actorId: opts.actor.userId,
        actorLabel: opts.actor.email,
        entityType: opts.entityType,
        entityId: opts.entityId,
        action: opts.action ?? `${opts.entityType.toLowerCase()}.soft_deleted`,
        diff: { deletedAt: { before: null, after: deletedAt.toISOString() } },
        meta: opts.meta,
      },
      tx,
    )
  })
}

/**
 * Application-level uniqueness for soft-deletable names.
 *
 * A database unique index cannot express this: once a team is soft-deleted its
 * row still occupies the name, so reusing the name would fail forever. Scoping
 * the check to `deletedAt: null` is the behaviour we actually want.
 *
 * Pass `exceptId` when renaming, so a row does not collide with itself.
 */
export async function assertNameAvailable(opts: {
  delegate: {
    findFirst: (args: { where: Record<string, unknown> }) => Promise<{ id: string } | null>
  }
  where: Record<string, unknown>
  label: string
  exceptId?: string
}): Promise<void> {
  const existing = await opts.delegate.findFirst({
    where: {
      ...opts.where,
      deletedAt: null,
      ...(opts.exceptId ? { id: { not: opts.exceptId } } : {}),
    },
  })
  if (existing) throw conflict(opts.label)
}
