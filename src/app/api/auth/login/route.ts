import { prisma } from '@/lib/prisma'
import { fakeVerify, verifyPassword } from '@/lib/password'
import { createSession, sessionCookie } from '@/lib/session'
import { HttpError, clientIp, handler, parseBody } from '@/lib/http'
import { AUTH_LIMITS, clearIdentifierLimit, enforceRateLimit } from '@/lib/rate-limit'
import { loginSchema } from '@/lib/validation'

export const POST = handler(async (req) => {
  const { email, password } = await parseBody(req, loginSchema)
  const ip = clientIp(req)

  // Before the database lookup and before argon2 runs. Password verification is
  // intentionally expensive, which makes an unlimited login endpoint both a
  // credential-stuffing target and a way to burn the server's CPU for free.
  enforceRateLimit({
    bucket: 'login',
    identifier: email,
    ip,
    ...AUTH_LIMITS.login,
    message: 'Too many sign-in attempts. Try again in a few minutes.',
  })

  const user = await prisma.user.findUnique({ where: { email } })

  // Same message and comparable work for "no such user" and "wrong password" so
  // the endpoint cannot be used to enumerate accounts.
  if (!user || user.deletedAt) {
    await fakeVerify()
    throw new HttpError(401, 'Email or password is incorrect.')
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new HttpError(401, 'Email or password is incorrect.')
  }

  // Authenticated. Forget the failed-attempt budget for this address so a user who
  // has just proved who they are is not throttled by an attacker who spent it.
  clearIdentifierLimit('login', email)

  const { token, expiresAt } = await createSession(user.id, {
    userAgent: req.headers.get('user-agent'),
    ip,
  })

  return Response.json(
    { user: { id: user.id, email: user.email, name: user.name } },
    { headers: { 'set-cookie': sessionCookie(token, expiresAt) } },
  )
})
