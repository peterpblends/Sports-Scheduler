import { prisma } from '@/lib/prisma'
import { handler, parseBody, requireActor } from '@/lib/http'
import { createOrgSchema, slugify } from '@/lib/validation'
import { recordAudit } from '@/lib/audit'

/** Organizations the signed-in user belongs to. */
export const GET = handler(async (req) => {
  const actor = await requireActor(req)
  return Response.json({ orgs: actor.memberships })
})

/** Any signed-in user may create an org; they become its owner. */
export const POST = handler(async (req) => {
  const actor = await requireActor(req)
  const { name, timezone } = await parseBody(req, createOrgSchema)

  const org = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: { name, timezone, slug: await uniqueSlug(name) },
    })
    await tx.membership.create({ data: { orgId: created.id, userId: actor.userId, role: 'owner' } })
    await recordAudit(
      {
        orgId: created.id,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Organization',
        entityId: created.id,
        action: 'org.created',
        diff: {
          name: { before: null, after: created.name },
          timezone: { before: null, after: created.timezone },
        },
      },
      tx,
    )
    await recordAudit(
      {
        orgId: created.id,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Membership',
        entityId: actor.userId,
        action: 'member.role_set',
        diff: { role: { before: null, after: 'owner' } },
        meta: { reason: 'org creator' },
      },
      tx,
    )
    return created
  })

  return Response.json({ org: { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone } }, { status: 201 })
})

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name)
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`
    const clash = await prisma.organization.findUnique({ where: { slug: candidate } })
    if (!clash) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}
