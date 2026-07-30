import Link from 'next/link'
import { CreateOrgForm } from '@/components/app-forms'
import { Card } from '@/components/ui'
import { requireActor } from '@/lib/auth-server'

export default async function NewOrgPage() {
  const actor = await requireActor('/new-org')

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <Card>
        <h1 className="text-xl font-semibold">Create an organization</h1>
        <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">
          An organization holds your leagues, teams, venues and officials. You will be its owner.
        </p>
        <CreateOrgForm />
        {actor.memberships.length > 0 && (
          <p className="mt-6 text-sm">
            <Link href="/app" className="text-ink-500 hover:underline dark:text-ink-300">
              Back to {actor.memberships[0]!.orgName}
            </Link>
          </p>
        )}
      </Card>
    </main>
  )
}
