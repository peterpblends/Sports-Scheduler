import { prisma } from '@/lib/prisma'
import { badRequest, handler, notFound } from '@/lib/http'
import { hashToken } from '@/lib/tokens'

/**
 * Public: turns an invitation token into just enough detail to render the
 * accept page (org name, invited address, role, and whether the invitee needs
 * to choose a password). Deliberately returns nothing about the org otherwise.
 */
export const GET = handler(async (req) => {
  const token = new URL(req.url).searchParams.get('token')
  if (!token) throw badRequest('Missing token.')

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { org: { select: { name: true } } },
  })

  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.revokedAt ||
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    throw notFound('That invitation is invalid, already used, or expired.')
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true, deletedAt: true },
  })

  return Response.json({
    invitation: {
      email: invitation.email,
      role: invitation.role,
      orgName: invitation.org.name,
      expiresAt: invitation.expiresAt,
      hasAccount: Boolean(existingUser && !existingUser.deletedAt),
    },
  })
})
