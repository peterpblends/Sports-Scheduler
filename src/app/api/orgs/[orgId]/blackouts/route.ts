import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createBlackoutSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertDivisionInOrg, assertTeamInOrg, assertVenueInOrg } from '@/lib/scope'
import { formatCalendarDate, parseCalendarDate } from '@/lib/time'
import type { BlackoutDate } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string }> }

const snapshot = (b: BlackoutDate) => ({
  scope: b.scope,
  divisionId: b.divisionId,
  teamId: b.teamId,
  venueId: b.venueId,
  startDate: formatCalendarDate(b.startDate),
  endDate: formatCalendarDate(b.endDate),
  reason: b.reason,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'venue:read')

  const blackouts = await prisma.blackoutDate.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { startDate: 'asc' },
    include: {
      division: { select: { id: true, name: true } },
      team: { select: { id: true, name: true } },
      venue: { select: { id: true, name: true } },
    },
  })

  return Response.json({
    blackouts: blackouts.map((b) => ({
      id: b.id,
      ...snapshot(b),
      division: b.division,
      team: b.team,
      venue: b.venue,
    })),
  })
})

export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  const data = await parseBody(req, createBlackoutSchema)

  // The scope's target must live in this org. The schema already guarantees
  // exactly one target id is set and that it matches the scope.
  if (data.divisionId) await assertDivisionInOrg(orgId, data.divisionId)
  if (data.teamId) await assertTeamInOrg(orgId, data.teamId)
  if (data.venueId) await assertVenueInOrg(orgId, data.venueId)

  const blackout = await createWithAudit({
    orgId,
    actor,
    entityType: 'BlackoutDate',
    id: (b) => b.id,
    snapshot,
    create: (tx) =>
      tx.blackoutDate.create({
        data: {
          orgId,
          scope: data.scope,
          divisionId: data.divisionId ?? null,
          teamId: data.teamId ?? null,
          venueId: data.venueId ?? null,
          startDate: parseCalendarDate(data.startDate),
          endDate: parseCalendarDate(data.endDate),
          reason: data.reason,
        },
      }),
  })

  return Response.json({ blackout: { id: blackout.id, ...snapshot(blackout) } }, { status: 201 })
})
