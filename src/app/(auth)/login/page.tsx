import Link from 'next/link'
import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/auth-forms'
import { Card } from '@/components/ui'
import { getActor } from '@/lib/auth-server'
import { safeRedirectPath } from '@/lib/redirect'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  // `?next=` is attacker-controlled. `startsWith('/')` would let `//evil.example`
  // through as a protocol-relative URL.
  if (await getActor()) redirect(safeRedirectPath(next))

  return (
    <Card>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">Welcome back.</p>
      <LoginForm next={next} />
      <div className="mt-6 flex justify-between text-sm text-ink-500 dark:text-ink-300">
        <Link href="/forgot-password" className="hover:underline">
          Forgot password?
        </Link>
        <Link href="/signup" className="font-medium text-turf-600 hover:underline">
          Create an account
        </Link>
      </div>
    </Card>
  )
}
