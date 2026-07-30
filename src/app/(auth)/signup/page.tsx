import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SignupForm } from '@/components/auth-forms'
import { Card } from '@/components/ui'
import { getActor } from '@/lib/auth-server'

export default async function SignupPage() {
  if (await getActor()) redirect('/app')

  return (
    <Card>
      <h1 className="text-xl font-semibold">Create your account</h1>
      <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">
        You will set up your organization next.
      </p>
      <SignupForm />
      <p className="mt-6 text-sm text-ink-500 dark:text-ink-300">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-turf-600 hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}
