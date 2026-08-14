import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getActor } from '@/lib/auth-server'
import { buttonClass, secondaryButtonClass } from '@/components/ui'
import { YardMark } from '@/components/logo'
import { ThemeToggle } from '@/components/theme-toggle'

export default async function Home() {
  const actor = await getActor()
  if (actor) redirect('/app')

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-16">
      <div className="mb-6 flex items-center justify-between">
        <YardMark size={32} />
        <ThemeToggle />
      </div>
      <p className="text-sm font-medium tracking-widest text-turf-600 uppercase">THE YARD</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
        Build a season schedule that holds up.
      </h1>
      <p className="mt-4 max-w-xl text-ink-600 dark:text-ink-300">
        Define teams, venues, officials and rules. Generate a schedule that respects every hard
        constraint, then review, publish, and roll back with a full audit trail.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/signup" className={buttonClass}>
          Create an account
        </Link>
        <Link href="/login" className={secondaryButtonClass}>
          Sign in
        </Link>
      </div>
    </main>
  )
}
