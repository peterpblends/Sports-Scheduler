import { prisma } from '@/lib/prisma'
import { handler, notFound, parseBody, requirePermission } from '@/lib/http'
import { nameSchema, timezoneSchema } from '@/lib/validation'
import { diffRecords, recordAudit } from '@/lib/audit'
import { z } from 'zod'

type Ctx = { params: Promise<{ orgId: string }> }

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { role } = await requirePermission(req, orgId, 'org:read')
  const org = await prisma.organization.findFirst({ where: { id: orgId, deletedAt: null } })
  if (!org) throw notFound('Organization not found.')
  return Response.json({
    org: { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone, settings: org.settings },
    role,
  })
})

const updateSchema = z.object({
  name: nameSchema.optional(),
  timezone: timezoneSchema.optional(),
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'org:update')
  const patch = await parseBody(req, updateSchema)

  const before = await prisma.organization.findFirst({ where: { id: orgId, deletedAt: null } })
  if (!before) throw notFound('Organization not found.')

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.organization.update({ where: { id: orgId }, data: patch })
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Organization',
        entityId: orgId,
        action: 'org.updated',
        diff: diffRecords(
          { name: before.name, timezone: before.timezone },
          { name: updated.name, timezone: updated.timezone },
        ),
      },
      tx,
    )
    return updated
  })

  return Response.json({ org: { id: after.id, name: after.name, timezone: after.timezone } })
})

/** Soft delete. Owner only — enforced by the `org:delete` permission. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'org:delete')

  const org = await prisma.organization.findFirst({ where: { id: orgId, deletedAt: null } })
  if (!org) throw notFound('Organization not found.')

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } })
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Organization',
        entityId: orgId,
        action: 'org.soft_deleted',
        diff: { deletedAt: { before: null, after: new Date().toISOString() } },
      },
      tx,
    )
  })

  return Response.json({ ok: true })
})
