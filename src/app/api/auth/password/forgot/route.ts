import { prisma } from '@/lib/prisma'
import { clientIp, handler, parseBody } from '@/lib/http'
import { AUTH_LIMITS, enforceRateLimit } from '@/lib/rate-limit'
import { forgotPasswordSchema } from '@/lib/validation'
import { generateToken, hashToken } from '@/lib/tokens'
import { appUrl, mailer } from '@/lib/mailer'

const TTL_MINUTES = 60

export const POST = handler(async (req) => {
  const { email } = await parseBody(req, forgotPasswordSchema)

  // Capped per address and per host: uncapped, this endpoint mails an arbitrary
  // third party on demand, which is a spam relay wearing a password-reset costume.
  // The limit is applied before the user lookup so it cannot be used to time
  // whether an account exists either.
  enforceRateLimit({
    bucket: 'password-reset',
    identifier: email,
    ip: clientIp(req),
    ...AUTH_LIMITS.passwordReset,
    message: 'Too many reset requests. Try again later.',
  })
  const user = await prisma.user.findUnique({ where: { email } })

  if (user && !user.deletedAt) {
    // Any earlier outstanding request is spent, so a stolen older link is dead.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    })

    const token = generateToken()
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
      },
    })

    const link = appUrl(`/reset-password?token=${encodeURIComponent(token)}`)
    await mailer().send({
      to: user.email,
      subject: 'Reset your password on THE YARD',
      text: `Hi ${user.name},\n\nUse this link within ${TTL_MINUTES} minutes to choose a new password:\n\n${link}\n\nIf you did not ask for this, you can ignore this email.\n`,
    })
  }

  // Identical response either way — this endpoint must not reveal who has an account.
  return Response.json({ ok: true })
})
