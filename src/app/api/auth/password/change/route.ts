import { prisma } from '@/lib/prisma'
import { HttpError, clientIp, handler, parseBody, requireActor } from '@/lib/http'
import { changePasswordSchema } from '@/lib/validation'
import { hashPassword, verifyPassword } from '@/lib/password'
import { createSession, sessionCookie } from '@/lib/session'
import { recordAudit } from '@/lib/audit'

export const POST = handler(async (req) => {
  const actor = await requireActor(req)
  const { currentPassword, newPassword } = await parseBody(req, changePasswordSchema)

  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } })
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new HttpError(400, 'Your current password is incorrect.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), sessionsValidFrom: new Date() },
    })
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await recordAudit(
      {
        actorId: user.id,
        actorLabel: user.email,
        entityType: 'User',
        entityId: user.id,
        action: 'user.password_change',
        meta: { ip: clientIp(req) },
      },
      tx,
    )
  })

  // Every old session is gone, including this one — issue a fresh one so the
  // person changing their password is not logged out of the tab they are in.
  const { token, expiresAt } = await createSession(user.id, {
    userAgent: req.headers.get('user-agent'),
    ip: clientIp(req),
  })

  return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token, expiresAt) } })
})
