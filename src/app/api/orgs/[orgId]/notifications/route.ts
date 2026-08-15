import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { handler, parseBody, requirePermission } from '@/lib/http'
import { NOTIFICATION_DEFAULTS, type NotificationKind } from '@/lib/notify'
import { diffRecords, recordAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ orgId: string }> }

/**
 * Derived from `NOTIFICATION_DEFAULTS` rather than written out again.
 *
 * That record is typed `Record<NotificationKind, boolean>`, so adding a kind to the
 * union forces it to be added there — and this endpoint and its schema then pick it
 * up for free. A hand-maintained copy here would silently ignore new kinds, which
 * is a preference that appears in the UI and does nothing when you toggle it.
 */
const KINDS = Object.keys(NOTIFICATION_DEFAULTS) as NotificationKind[]

const schema = z.object(
  Object.fromEntries(KINDS.map((kind) => [kind, z.boolean().optional()])) as Record<
    NotificationKind,
    z.ZodOptional<z.ZodBoolean>
  >,
)

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
