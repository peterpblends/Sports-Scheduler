import { prisma } from '@/lib/prisma'
import { badRequest, handler, parseBody, requirePermission } from '@/lib/http'
import { createRelationshipSchema } from '@/lib/validation'
import { recordAudit } from '@/lib/audit'
import { assertPersonInOrg } from '@/lib/scope'

type Ctx = { params: Promise<{ orgId: string; personId: string }> }

/**
 * Family links between people. Stored in both directions so that "who is related
 * to X" is a single indexed lookup from either side — the scheduler asks that
 * question for every candidate official on every game.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, personId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const data = await parseBody(req, createRelationshipSchema)

  if (data.relatedPersonId === personId) throw badRequest('A person cannot be related to themselves.')

  await assertPersonInOrg(orgId, personId)
  await assertPersonInOrg(orgId, data.relatedPersonId)

  await prisma.$transaction(async (tx) => {
    for (const [a, b] of [
      [personId, data.relatedPersonId],
      [data.relatedPersonId, personId],
    ]) {
      await tx.personRelationship.upsert({
        where: {
          personId_relatedPersonId_kind: { personId: a!, relatedPersonId: b!, kind: data.kind },
        },
        update: { deletedAt: null },
        create: { personId: a!, relatedPersonId: b!, kind: data.kind },
      })
    }
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'PersonRelationship',
        entityId: personId,
        action: 'person.relationship_added',
        diff: { relatedPersonId: { before: null, after: data.relatedPersonId } },
        meta: { kind: data.kind, bidirectional: true },
      },
      tx,
    )
  })

  return Response.json({ ok: true }, { status: 201 })
})

/** Removes the link in both directions. */
export const DELETE = handler<Ctx>(async (req, ctx) => {
  const { orgId, personId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'roster:write')
  const relatedPersonId = new URL(req.url).searchParams.get('relatedPersonId')
  if (!relatedPersonId) throw badRequest('Pass relatedPersonId.')

  await assertPersonInOrg(orgId, personId)
  await assertPersonInOrg(orgId, relatedPersonId)

  const deletedAt = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.personRelationship.updateMany({
      where: {
        deletedAt: null,
        OR: [
          { personId, relatedPersonId },
          { personId: relatedPersonId, relatedPersonId: personId },
        ],
      },
      data: { deletedAt },
    })
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'PersonRelationship',
        entityId: personId,
        action: 'person.relationship_removed',
        diff: { relatedPersonId: { before: relatedPersonId, after: null } },
      },
      tx,
    )
  })

  return Response.json({ ok: true })
})
