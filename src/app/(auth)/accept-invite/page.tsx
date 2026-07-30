import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/tokens'
import { getActor } from '@/lib/auth-server'
import { AcceptInviteForm } from '@/components/auth-forms'
import { Alert, Card } from '@/components/ui'

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Invitation</h1>
        <div className="mt-6">
          <Alert>This invitation link is missing its token.</Alert>
        </div>
      </Card>
    )
  }

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { org: { select: { name: true, deletedAt: true } } },
  })

  const usable =
    invitation &&
    !invitation.acceptedAt &&
    !invitation.revokedAt &&
    !invitation.org.deletedAt &&
    invitation.expiresAt.getTime() > Date.now()

  if (!usable) {
    return (
      <Card>
        <h1 className="text-xl font-semibold">Invitation</h1>
        <div className="mt-6 space-y-4">
          <Alert>That invitation is invalid, already used, or expired. Ask an admin to resend it.</Alert>
          <Link href="/login" className="text-sm text-turf-600 hover:underline">
            Go to sign in
          </Link>
        </div>
      </Card>
    )
  }

  const [actor, existingUser] = await Promise.all([
    getActor(),
    prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true, deletedAt: true },
    }),
  ])

  return (
    <Card>
      <h1 className="mb-6 text-xl font-semibold">You have been invited</h1>
      <AcceptInviteForm
        token={token}
        signedInAs={actor?.email ?? null}
        invitation={{
          email: invitation.email,
          role: invitation.role,
          orgName: invitation.org.name,
          hasAccount: Boolean(existingUser && !existingUser.deletedAt),
        }}
      />
    </Card>
  )
}
