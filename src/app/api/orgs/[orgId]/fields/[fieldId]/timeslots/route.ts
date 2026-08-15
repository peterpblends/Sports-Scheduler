import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { createTimeSlotSchema } from '@/lib/validation'
import { createWithAudit } from '@/lib/crud'
import { assertFieldInOrg } from '@/lib/scope'
import { parseCalendarDate } from '@/lib/time'
import type { TimeSlot } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; fieldId: string }> }

const snapshot = (s: TimeSlot) => ({
  dayOfWeek: s.dayOfWeek,
  specificDate: s.specificDate?.toISOString() ?? null,
  startMinute: s.startMinute,
  endMinute: s.endMinute,
  effectiveFrom: s.effectiveFrom?.toISOString() ?? null,
  effectiveTo: s.effectiveTo?.toISOString() ?? null,
  notes: s.notes,
})

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, fieldId } = await ctx.params
  await requirePermission(req, orgId, 'venue:read')
  const field = await assertFieldInOrg(orgId, fieldId)

  const timeSlots = await prisma.timeSlot.findMany({
    where: { fieldId, deletedAt: null },
    orderBy: [{ dayOfWeek: 'asc' }, { specificDate: 'asc' }, { startMinute: 'asc' }],
  })

  // The venue zone travels with the slots: minute offsets are meaningless without it.
  return Response.json({ timeSlots, timezone: field.venue.timezone })
})

/**
 * Time slots are windows of local wall-clock time, stored as minutes from
 * midnight rather than instants. "Field 2, Saturdays 8am-6pm, Mar 1 - Jun 15"
 * therefore keeps meaning 8am local on both sides of a DST change; the phase 3
 * generator converts each occurrence to a UTC instant using the venue's zone.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, fieldId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'venue:write')
  await assertFieldInOrg(orgId, fieldId)
  const data = await parseBody(req, createTimeSlotSchema)

  const timeSlot = await createWithAudit({
    orgId,
    actor,
    entityType: 'TimeSlot',
    id: (s) => s.id,
    snapshot,
    meta: { fieldId, kind: data.kind },
    create: (tx) =>
      tx.timeSlot.create({
        data:
          data.kind === 'recurring'
            ? {
                fieldId,
                dayOfWeek: data.dayOfWeek,
                startMinute: data.startTime,
                endMinute: data.endTime,
                effectiveFrom: data.effectiveFrom ? parseCalendarDate(data.effectiveFrom) : null,
                effectiveTo: data.effectiveTo ? parseCalendarDate(data.effectiveTo) : null,
                notes: data.notes ?? null,
              }
            : {
                fieldId,
                specificDate: parseCalendarDate(data.specificDate),
                startMinute: data.startTime,
                endMinute: data.endTime,
                notes: data.notes ?? null,
              },
      }),
  })

  return Response.json({ timeSlot: { id: timeSlot.id, ...snapshot(timeSlot) } }, { status: 201 })
})
