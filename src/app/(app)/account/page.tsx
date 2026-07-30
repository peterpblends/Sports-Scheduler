import Link from 'next/link'
import { requireActor } from '@/lib/auth-server'
import { ChangePasswordForm, SessionsManager, SignOutButton } from '@/components/app-forms'
import { Card, PageHeader, RoleBadge } from '@/components/ui'

export default async function AccountPage() {
  const actor = await requireActor('/account')

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <PageHeader title="Account" subtitle={actor.email} action={<SignOutButton />} />

      <div className="space-y-4">
        <Card>
          <h2 className="text-base font-semibold">Organizations</h2>
          <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
            {actor.memberships.map((m) => (
              <li key={m.orgId} className="flex items-center justify-between gap-4 py-2">
                <Link href={`/app/${m.orgSlug}`} className="font-medium text-turf-600 hover:underline">
                  {m.orgName}
                </Link>
                <RoleBadge role={m.role} />
              </li>
            ))}
          </ul>
          <Link href="/new-org" className="mt-4 inline-block text-sm text-turf-600 hover:underline">
            Create another organization
          </Link>
        </Card>

        <ChangePasswordForm />
        <SessionsManager />
      </div>
    </div>
  )
}
