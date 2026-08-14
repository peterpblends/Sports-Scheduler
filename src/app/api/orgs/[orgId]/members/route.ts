import { prisma } from '@/lib/prisma'
import { conflict, forbidden, handler, parseBody, requirePermission } from '@/lib/http'
import { inviteSchema } from '@/lib/validation'
import { recordAudit } from '@/lib/audit'
import { generateToken, hashToken } from '@/lib/tokens'
import { appUrl, mailer } from '@/lib/mailer'
import { rank } from '@/lib/authz'
import { AUTH_LIMITS, enforceRateLimit } from '@/lib/rate-limit'

type Ctx = { params: Promise<{ orgId: string }> }

const INVITE_TTL_DAYS = 14

export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'member:read')

  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { orgId, deletedAt: null },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.invitation.findMany({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
    }),
  ])

  return Response.json({
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      joinedAt: m.createdAt,
      user: m.user,
    })),
    invitations,
  })
})

/** Invite by email. Requires `member:invite`, which schedulers do not hold. */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  const { actor, role: actorRole } = await requirePermission(req, orgId, 'member:invite')
  const { email, role } = await parseBody(req, inviteSchema)

  // Authenticated, but each call sends an email to an address the caller chooses, so
  // an admin account is still a usable spam relay without a cap. Keyed on the actor
  // rather than the recipient, since the actor is the one being limited.
  enforceRateLimit({
    bucket: 'invitation',
    identifier: actor.userId,
    ...AUTH_LIMITS.invitation,
    message: 'Too many invitations sent. Try again later.',
  })

  // An inviter can never hand out more authority than they hold.
  if (rank(role) > rank(actorRole)) {
    throw forbidden('You cannot invite someone at a role above your own.')
  }

  const alreadyMember = await prisma.membership.findFirst({
    where: { orgId, deletedAt: null, user: { email } },
  })
  if (alreadyMember) throw conflict('That person is already a member of this organization.')

  const token = generateToken()
  const invitation = await prisma.$transaction(async (tx) => {
    // Supersede any outstanding invitation for the same address.
    await tx.invitation.updateMany({
      where: { orgId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    const created = await tx.invitation.create({
      data: {
        orgId,
        email,
        role,
        tokenHash: hashToken(token),
        createdById: actor.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    })
    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Invitation',
        entityId: created.id,
        action: 'invitation.created',
        diff: {
          email: { before: null, after: email },
          role: { before: null, after: role },
        },
      },
      tx,
    )
    return created
  })

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
  const link = appUrl(`/accept-invite?token=${encodeURIComponent(token)}`)
  await mailer().send({
    to: email,
    subject: `${actor.name} invited you to ${org.name} on THE YARD`,
    text: `${actor.name} (${actor.email}) invited you to join ${org.name} as ${role}.\n\nAccept the invitation here — the link is good for ${INVITE_TTL_DAYS} days:\n\n${link}\n`,
  })

  return Response.json(
    {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
      // Returned only outside production so the demo flow does not need a mail client.
      ...(process.env.NODE_ENV === 'production' ? {} : { acceptUrl: link }),
    },
    { status: 201 },
  )
})
