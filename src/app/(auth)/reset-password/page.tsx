import Link from 'next/link'
import { ResetPasswordForm } from '@/components/auth-forms'
import { Alert, Card } from '@/components/ui'

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  return (
    <Card>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <div className="mt-6">
        {token ? (
          <ResetPasswordForm token={token} />
        ) : (
          <div className="space-y-4">
            <Alert>This link is missing its token. Request a new reset email.</Alert>
            <Link href="/forgot-password" className="text-sm text-turf-600 hover:underline">
              Request a new link
            </Link>
          </div>
        )}
      </div>
    </Card>
  )
}
