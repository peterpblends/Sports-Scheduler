import { prisma } from '@/lib/prisma'
import { HttpError, clientIp, handler, parseBody } from '@/lib/http'
import { AUTH_LIMITS, enforceRateLimit } from '@/lib/rate-limit'
import { resetPasswordSchema } from '@/lib/validation'
import { hashToken } from '@/lib/tokens'
import { hashPassword } from '@/lib/password'
import { createSession, sessionCookie } from '@/lib/session'
import { recordAudit } from '@/lib/audit'

export const POST = handler(async (req) => {
  // Token-guessing surface. The tokens are 256-bit, so guessing is not the real
  // risk — unbounded work and unbounded audit noise are.
  enforceRateLimit({
    bucket: 'password-reset-submit',
    ip: clientIp(req),
    ...AUTH_LIMITS.tokenSubmission,
    message: 'Too many attempts. Try again shortly.',
  })

  const { token, password } = await parseBody(req, resetPasswordSchema)

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  })

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now() || record.user.deletedAt) {
    throw new HttpError(400, 'That reset link is invalid or has expired.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } })
    await tx.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(password),
        // Retires every session issued before this moment.
        sessionsValidFrom: new Date(),
      },
    })
    await tx.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await recordAudit(
      {
        actorId: record.userId,
        actorLabel: record.user.email,
        entityType: 'User',
        entityId: record.userId,
        action: 'user.password_reset',
        meta: { ip: clientIp(req) },
      },
      tx,
    )
  })

  // Sign the user straight in on the new credentials.
  const { token: sessionToken, expiresAt } = await createSession(record.userId, {
    userAgent: req.headers.get('user-agent'),
    ip: clientIp(req),
  })

  return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(sessionToken, expiresAt) } })
})
