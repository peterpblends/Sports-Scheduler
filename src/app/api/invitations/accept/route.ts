import { prisma } from '@/lib/prisma'
import { HttpError, badRequest, clientIp, conflict, forbidden, handler, parseBody } from '@/lib/http'
import { AUTH_LIMITS, enforceRateLimit } from '@/lib/rate-limit'
import { acceptInviteSchema } from '@/lib/validation'
import { hashToken } from '@/lib/tokens'
import { hashPassword } from '@/lib/password'
import { createSession, getActorFromRequest, sessionCookie } from '@/lib/session'
import { recordAudit } from '@/lib/audit'

/**
 * Accepting an invitation lands the invitee in the right org with the role the
 * inviter chose. The role comes from the invitation row — never from the request
 * body — so a tampered payload cannot upgrade itself.
 *
 * Three cases:
 *  1. already signed in as the invited address -> just add the membership
 *  2. no account for the address yet -> create it from name + password, sign in
 *  3. account exists but nobody is signed in -> 409, sign in and retry
 */
export const POST = handler(async (req) => {
  // Token-guessing surface. The tokens are 256-bit, so guessing is not the real
  // risk — unbounded work and unbounded audit noise are.
  enforceRateLimit({
    bucket: 'invitation-accept',
    ip: clientIp(req),
    ...AUTH_LIMITS.tokenSubmission,
    message: 'Too many attempts. Try again shortly.',
  })

  const { token, name, password } = await parseBody(req, acceptInviteSchema)

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { org: { select: { id: true, name: true, slug: true, deletedAt: true } } },
  })

  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.revokedAt ||
    invitation.expiresAt.getTime() <= Date.now() ||
    invitation.org.deletedAt
  ) {
    throw badRequest('That invitation is invalid, already used, or expired.')
  }

  const actor = await getActorFromRequest(req)
  let userId: string
  let userEmail: string
  let issueSession = false

  if (actor) {
    if (actor.email !== invitation.email) {
      throw forbidden(
        `This invitation is for ${invitation.email}. Sign out and open the link again to accept it.`,
      )
    }
    userId = actor.userId
    userEmail = actor.email
  } else {
    const existing = await prisma.user.findUnique({ where: { email: invitation.email } })
    if (existing && !existing.deletedAt) {
      throw conflict('You already have an account. Sign in first, then open the invitation link again.')
    }
    if (!name || !password) {
      throw new HttpError(400, 'Choose a name and password to finish setting up your account.')
    }
    const created = await prisma.user.create({
      data: { name, email: invitation.email, passwordHash: await hashPassword(password) },
    })
    userId = created.id
    userEmail = created.email
    issueSession = true
  }

  const already = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId: invitation.orgId } },
  })
  if (already && !already.deletedAt) throw conflict('You are already a member of this organization.')

  await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction so two concurrent accepts cannot both win.
    const fresh = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    })
    if (fresh.count === 0) throw conflict('That invitation was already used.')

    if (already) {
      // Rejoining after a previous removal reuses the row and clears the soft delete.
      await tx.membership.update({
        where: { id: already.id },
        data: { role: invitation.role, deletedAt: null },
      })
    } else {
      await tx.membership.create({ data: { userId, orgId: invitation.orgId, role: invitation.role } })
    }

    await recordAudit(
      {
        orgId: invitation.orgId,
        actorId: userId,
        actorLabel: userEmail,
        entityType: 'Invitation',
        entityId: invitation.id,
        action: 'invitation.accepted',
        diff: { acceptedAt: { before: null, after: new Date().toISOString() } },
        meta: { role: invitation.role, userId },
      },
      tx,
    )
    await recordAudit(
      {
        orgId: invitation.orgId,
        actorId: userId,
        actorLabel: userEmail,
        entityType: 'Membership',
        entityId: userId,
        action: 'member.joined',
        diff: { role: { before: null, after: invitation.role } },
        meta: { via: 'invitation', invitationId: invitation.id },
      },
      tx,
    )
  })

  const headers: Record<string, string> = {}
  if (issueSession) {
    const { token: sessionToken, expiresAt } = await createSession(userId, {
      userAgent: req.headers.get('user-agent'),
      ip: clientIp(req),
    })
    headers['set-cookie'] = sessionCookie(sessionToken, expiresAt)
  }

  return Response.json(
    { org: { id: invitation.org.id, name: invitation.org.name, slug: invitation.org.slug }, role: invitation.role },
    { headers },
  )
})
