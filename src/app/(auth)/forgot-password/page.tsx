import Link from 'next/link'
import { ForgotPasswordForm } from '@/components/auth-forms'
import { Card } from '@/components/ui'

export default function ForgotPasswordPage() {
  return (
    <Card>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">
        Enter the email on your account and we will send a reset link.
      </p>
      <ForgotPasswordForm />
      <p className="mt-6 text-sm">
        <Link href="/login" className="text-ink-500 hover:underline dark:text-ink-300">
          Back to sign in
        </Link>
      </p>
    </Card>
  )
}
