import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { updatePersonSchema } from '@/lib/validation'
import { softDeleteWithAudit, updateWithAudit } from '@/lib/crud'
import { assertPersonInOrg } from '@/lib/scope'
import { parseCalendarDate } from '@/lib/time'
import { assertUserLinkable } from '@/lib/roster'
import type { Person } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; personId: string }> }

const snapshot = (p: Person) => ({
  name: p.name,
  email: p.email,
  phone: p.phone,
  dob: p.dob?.toISOString() ?? null,
  notes: p.notes,
  hasConflictOfInterest: p.hasConflictOfInterest,
  conflictNote: p.conflictNote,
  userId: p.userId,
  photoUrl: p.photoUrl,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, personId } = await ctx.params
  await requirePermission(req, orgId, 'roster:read')
  await assertPersonInOrg(orgId, personId)

  const person = await prisma.person.findUniqueOrThrow({
    where: { id: personId },
    include: {
      referee: true,
      teamMemberships: {
        where: { deletedAt: null },
        include: { team: { select: { id: true, name: true, divisionId: true } } },
      },
      relationships: {
        where: { deletedAt: null },
        include: { relatedPerson: { select: { id: true, name: true } } },
      },
    },
  })

  return Response.json({
    person: {
      id: person.id,
      ...snapshot(person),
      referee: person.referee && !person.referee.deletedAt ? person.referee : null,
      teams: person.teamMemberships.map((m) => ({
        membershipId: m.id,
        role: m.role,
        jerseyNumber: m.jerseyNumber,
        team: m.team,
      })),
      relationships: person.relationships.map((r) => ({
        id: r.id,
        kind: r.kind,
        person: r.relatedPerson,
      })),
    },
  })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId, personId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const before = await assertPersonInOrg(orgId, personId)
  const patch = await parseBody(req, updatePersonSchema)

  if (patch.userId) await assertUserLinkable(orgId, patch.userId, personId)

  const person = await updateWithAudit({
    orgId,
    actor,
    entityType: 'Person',
    entityId: personId,
    before: snapshot(before),
    snapshot,
    update: (tx) =>
      tx.person.update({
        where: { id: personId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.email !== undefined ? { email: patch.email ?? null } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone ?? null } : {}),
          ...(patch.dob !== undefined
            ? { dob: patch.dob ? parseCalendarDate(patch.dob) : null }
            : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
          ...(patch.hasConflictOfInterest !== undefined
            ? { hasConflictOfInterest: patch.hasConflictOfInterest }
            : {}),
          ...(patch.conflictNote !== undefined ? { conflictNote: patch.conflictNote ?? null } : {}),
          ...(patch.userId !== undefined ? { userId: patch.userId ?? null } : {}),
          ...(patch.photoUrl !== undefined ? { photoUrl: patch.photoUrl ?? null } : {}),
        },
      }),
  })

  return Response.json({ person: { id: person.id, ...snapshot(person) } })
})

export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, personId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  await assertPersonInOrg(orgId, personId)

  await softDeleteWithAudit({
    orgId,
    actor,
    entityType: 'Person',
    entityId: personId,
    softDelete: (tx, deletedAt) =>
      tx.person.updateMany({ where: { id: personId, deletedAt: null }, data: { deletedAt } }),
  })

  return Response.json({ ok: true })
})
