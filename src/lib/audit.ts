import { prisma } from './prisma'
import type { Prisma } from '@prisma/client'

export type FieldDiff = Record<string, { before: unknown; after: unknown }>

export type AuditInput = {
  orgId?: string | null
  actorId?: string | null
  actorLabel: string
  entityType: string
  entityId: string
  action: string
  diff?: FieldDiff
  meta?: Record<string, unknown>
}

/**
 * Append-only. Every mutation in the app funnels through here; nothing ever
 * updates or deletes an AuditEvent row.
 *
 * Pass `tx` to record the event inside the same transaction as the mutation so
 * a rolled-back write cannot leave a phantom audit entry (and a committed one
 * can never be missing its entry).
 */
export async function recordAudit(
  input: AuditInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      orgId: input.orgId ?? null,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      diff: (input.diff ?? {}) as Prisma.InputJsonValue,
      meta: (input.meta ?? {}) as Prisma.InputJsonValue,
    },
  })
}

const REDACTED = new Set(['passwordHash', 'tokenHash', 'password'])

/** Field-level before/after diff of two shallow records, secrets redacted. */
export function diffRecords(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldDiff {
  const diff: FieldDiff = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const key of keys) {
    if (REDACTED.has(key)) continue
    const b = before?.[key]
    const a = after?.[key]
    if (!sameValue(b, a)) diff[key] = { before: normalize(b), after: normalize(a) }
  }
  return diff
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value === undefined ? null : value
}

function sameValue(a: unknown, b: unknown): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return true
  if (na === null || nb === null) return false
  if (typeof na === 'object' || typeof nb === 'object') {
    return JSON.stringify(na) === JSON.stringify(nb)
  }
  return false
}

/**
 * Bulk append. Generating a season creates hundreds of games, and the spec asks for an
 * audit event per entity mutation — one insert rather than hundreds keeps that
 * affordable without weakening the guarantee.
 */
export async function recordAuditMany(
  events: AuditInput[],
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  if (events.length === 0) return
  await tx.auditEvent.createMany({
    data: events.map((input) => ({
      orgId: input.orgId ?? null,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      diff: (input.diff ?? {}) as Prisma.InputJsonValue,
      meta: (input.meta ?? {}) as Prisma.InputJsonValue,
    })),
  })
}
