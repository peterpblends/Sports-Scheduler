import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { NOTIFICATION_DEFAULTS, type NotificationKind } from '@/lib/notify'
import { diffRecords, recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string }> }

const KINDS = ['schedulePublished', 'gameRescheduled', 'assignmentChanged', 'rosterChanged'] as const

const schema = z.object({
  schedulePublished: z.boolean().optional(),
  gameRescheduled: z.boolean().optional(),
  assignmentChanged: z.boolean().optional(),
  rosterChanged: z.boolean().optional(),
})

/**
 * A user's own notification settings for one org.
 *
 * Only ever the caller's own — there is no endpoint for reading or changing someone
 * else's, deliberately. `org:read` is the floor because every member has preferences,
 * whatever else their role can or cannot do.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'org:read')

  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_orgId: { userId: actor.userId, orgId } },
  })

  // No row means the defaults, which is why one is not created on read.
  return Response.json({
    preferences: Object.fromEntries(
      KINDS.map((kind) => [kind, pref ? pref[kind] : NOTIFICATION_DEFAULTS[kind]]),
    ),
    explicit: pref !== null,
  })
})

export const PATCH = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'org:read')
  const patch = await parseBody(req, schema)

  const existing = await prisma.notificationPreference.findUnique({
    where: { userId_orgId: { userId: actor.userId, orgId } },
  })

  const before = Object.fromEntries(
    KINDS.map((kind) => [kind, existing ? existing[kind] : NOTIFICATION_DEFAULTS[kind]]),
  ) as Record<NotificationKind, boolean>

  const after = { ...before }
  for (const kind of KINDS) if (patch[kind] !== undefined) after[kind] = patch[kind]!

  const saved = await prisma.notificationPreference.upsert({
    where: { userId_orgId: { userId: actor.userId, orgId } },
    create: { userId: actor.userId, orgId, ...after },
    update: after,
  })

  // Worth recording: "I never asked for these emails" is a real dispute.
  const diff = diffRecords(before, after)
  if (Object.keys(diff).length > 0) {
    await recordAudit({
      orgId,
      actorId: actor.userId,
      actorLabel: actor.email,
      entityType: 'NotificationPreference',
      entityId: saved.id,
      action: 'notifications.updated',
      diff,
    })
  }

  return Response.json({ preferences: after })
})
