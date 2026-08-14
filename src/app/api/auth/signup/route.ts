import { prisma } from '@/lib/prisma'
import { hashPassword } from '@/lib/password'
import { createSession, sessionCookie } from '@/lib/session'
import { clientIp, conflict, handler, parseBody } from '@/lib/http'
import { AUTH_LIMITS, enforceRateLimit } from '@/lib/rate-limit'
import { signupSchema } from '@/lib/validation'
import { recordAudit } from '@/lib/audit'

export const POST = handler(async (req) => {
  // Account creation is open by design; unlimited account creation is not.
  enforceRateLimit({
    bucket: 'signup',
    ip: clientIp(req),
    ...AUTH_LIMITS.signup,
    message: 'Too many accounts created from here. Try again later.',
  })

  const { name, email, password } = await parseBody(req, signupSchema)

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) throw conflict('An account with that email already exists.')

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name, email, passwordHash: await hashPassword(password) },
    })
    await recordAudit(
      {
        actorId: created.id,
        actorLabel: created.email,
        entityType: 'User',
        entityId: created.id,
        action: 'user.signup',
        diff: { email: { before: null, after: created.email }, name: { before: null, after: created.name } },
      },
      tx,
    )
    return created
  })

  const { token, expiresAt } = await createSession(user.id, {
    userAgent: req.headers.get('user-agent'),
    ip: clientIp(req),
  })

  return Response.json(
    { user: { id: user.id, email: user.email, name: user.name } },
    { status: 201, headers: { 'set-cookie': sessionCookie(token, expiresAt) } },
  )
})
