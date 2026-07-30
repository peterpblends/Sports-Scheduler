import { prisma } from '@/lib/prisma'
import { conflict, handler, parseBody, requirePermission } from '@/lib/http'
import { createRefereeSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertPersonInOrg, assertVenueInOrg } from '@/lib/scope'
import type { Referee } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (r: Referee) => ({
  personId: r.personId,
  certificationLevel: r.certificationLevel,
  payRateCents: r.payRateCents,
  maxGamesPerDay: r.maxGamesPerDay,
  travelBufferMinutes: r.travelBufferMinutes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'official:read')

  const referees = await prisma.referee.findMany({
    where: { deletedAt: null, person: { orgId, deletedAt: null } },
    orderBy: { person: { name: 'asc' } },
    include: {
      person: { select: { id: true, name: true, email: true, phone: true, hasConflictOfInterest: true } },
      preferredVenues: { select: { id: true, name: true } },
      availability: { where: { deletedAt: null } },
      _count: { select: { assignments: { where: { deletedAt: null } } } },
    },
  })

  return Response.json({
    referees: referees.map((r) => ({
      id: r.id,
      ...snapshot(r),
      person: r.person,
      preferredVenues: r.preferredVenues,
      availability: r.availability,
      assignmentCount: r._count.assignments,
    })),
  })
})

/** Flags an existing Person as an official. */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const data = await parseBody(req, createRefereeSchema)

  await assertPersonInOrg(orgId, data.personId)
  for (const venueId of data.preferredVenueIds) await assertVenueInOrg(orgId, venueId)

  const existing = await prisma.referee.findUnique({ where: { personId: data.personId } })
  if (existing && !existing.deletedAt) throw conflict('That person is already registered as a referee.')

  const referee = await createWithAudit({
    orgId,
    actor,
    entityType: 'Referee',
    id: (r) => r.id,
    snapshot,
    meta: { personId: data.personId },
    create: (tx) =>
      // Re-flagging a previously removed official reuses the row so their
      // assignment history stays attached.
      existing
        ? tx.referee.update({
            where: { id: existing.id },
            data: {
              deletedAt: null,
              certificationLevel: data.certificationLevel ?? null,
              payRateCents: data.payRateCents ?? null,
              maxGamesPerDay: data.maxGamesPerDay,
              travelBufferMinutes: data.travelBufferMinutes,
              preferredVenues: { set: data.preferredVenueIds.map((id) => ({ id })) },
            },
          })
        : tx.referee.create({
            data: {
              personId: data.personId,
              certificationLevel: data.certificationLevel ?? null,
              payRateCents: data.payRateCents ?? null,
              maxGamesPerDay: data.maxGamesPerDay,
              travelBufferMinutes: data.travelBufferMinutes,
              preferredVenues: { connect: data.preferredVenueIds.map((id) => ({ id })) },
            },
          }),
  })

  return Response.json({ referee: { id: referee.id, ...snapshot(referee) } }, { status: 201 })
})
