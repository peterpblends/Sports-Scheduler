import { prisma } from '@/lib/prisma'
import { fakeVerify, verifyPassword } from '@/lib/password'
import { createSession, sessionCookie } from '@/lib/session'
import { HttpError, clientIp, handler, parseBody } from '@/lib/http'
import { loginSchema } from '@/lib/validation'

export const POST = handler(async (req) => {
  const { email, password } = await parseBody(req, loginSchema)

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

  const { token, expiresAt } = await createSession(user.id, {
    userAgent: req.headers.get('user-agent'),
    ip: clientIp(req),
  })

  return Response.json(
    { user: { id: user.id, email: user.email, name: user.name } },
    { headers: { 'set-cookie': sessionCookie(token, expiresAt) } },
  )
})
