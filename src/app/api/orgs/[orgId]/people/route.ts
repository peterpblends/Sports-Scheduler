import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createPersonSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertUserLinkable } from '@/lib/roster'
import { parseCalendarDate } from '@/lib/time'
import type { Person } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

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
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'roster:read')

  const params = new URL(req.url).searchParams
  const search = params.get('q')?.trim()
  const refereesOnly = params.get('referees') === 'true'

  const people = await prisma.person.findMany({
    where: {
      orgId,
      deletedAt: null,
      ...(refereesOnly ? { referee: { isNot: null, is: { deletedAt: null } } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { name: 'asc' },
    take: 500,
    include: {
      referee: { select: { id: true, certificationLevel: true, deletedAt: true } },
      teamMemberships: {
        where: { deletedAt: null },
        select: { id: true, role: true, team: { select: { id: true, name: true } } },
      },
    },
  })

  return Response.json({
    people: people.map((p) => ({
      id: p.id,
      ...snapshot(p),
      referee: p.referee && !p.referee.deletedAt ? { id: p.referee.id } : null,
      teams: p.teamMemberships.map((m) => ({ id: m.team.id, name: m.team.name, role: m.role })),
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const data = await parseBody(req, createPersonSchema)

  if (data.userId) await assertUserLinkable(orgId, data.userId)

  const person = await createWithAudit({
    orgId,
    actor,
    entityType: 'Person',
    id: (p) => p.id,
    snapshot,
    create: (tx) =>
      tx.person.create({
        data: {
          orgId,
          name: data.name,
          email: data.email ?? null,
          phone: data.phone ?? null,
          dob: data.dob ? parseCalendarDate(data.dob) : null,
          notes: data.notes ?? null,
          hasConflictOfInterest: data.hasConflictOfInterest,
          conflictNote: data.conflictNote ?? null,
          userId: data.userId ?? null,
          photoUrl: data.photoUrl ?? null,
        },
      }),
  })

  return Response.json({ person: { id: person.id, ...snapshot(person) } }, { status: 201 })
})
