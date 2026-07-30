import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireActor } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { RoleBadge } from '@/components/ui'
import { SignOutButton } from '@/components/app-forms'

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const actor = await requireActor(`/app/${orgSlug}`)
  const membership = actor.memberships.find((m) => m.orgSlug === orgSlug)
  if (!membership) notFound()

  // Nav is filtered by the same permission matrix the server enforces. Hiding a
  // link is a convenience, not the control — every endpoint re-checks.
  const nav = [
    { href: `/app/${orgSlug}`, label: 'Dashboard', show: true },
    { href: `/app/${orgSlug}/schedule`, label: 'Schedule', show: can(membership.role, 'schedule:read:published') },
    {
      href: `/app/${orgSlug}/schedule/officials`,
      label: 'Officiating',
      show: can(membership.role, 'official:assign'),
    },
    { href: `/app/${orgSlug}/leagues`, label: 'Leagues', show: can(membership.role, 'structure:read') },
    { href: `/app/${orgSlug}/venues`, label: 'Venues', show: can(membership.role, 'venue:read') },
    { href: `/app/${orgSlug}/people`, label: 'People', show: can(membership.role, 'roster:read') },
    { href: `/app/${orgSlug}/members`, label: 'Members', show: can(membership.role, 'member:read') },
    { href: `/app/${orgSlug}/activity`, label: 'Activity', show: can(membership.role, 'audit:read') },
    {
      href: `/app/${orgSlug}/subscriptions`,
      label: 'Subscriptions',
      show: can(membership.role, 'schedule:read:published'),
    },
    { href: `/app/${orgSlug}/setup`, label: 'Setup', show: can(membership.role, 'structure:write') },
    { href: '/account', label: 'Account', show: true },
  ].filter((item) => item.show)

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <Link href="/app" className="text-sm font-semibold uppercase tracking-widest text-turf-600">
            Sports Scheduler
          </Link>

          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{membership.orgName}</span>
            <RoleBadge role={membership.role} />
          </div>

          <nav className="flex items-center gap-4 text-sm">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-ink-600 hover:text-turf-600 dark:text-ink-300"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            {actor.memberships.length > 1 && (
              // Switching org is plain navigation, so links keep this a server component.
              <div className="flex items-center gap-2 text-sm">
                {actor.memberships
                  .filter((m) => m.orgSlug !== orgSlug)
                  .map((m) => (
                    <Link
                      key={m.orgId}
                      href={`/app/${m.orgSlug}`}
                      className="text-ink-500 hover:text-turf-600 dark:text-ink-300"
                    >
                      {m.orgName}
                    </Link>
                  ))}
              </div>
            )}
            <span className="hidden text-sm text-ink-500 sm:inline dark:text-ink-300">{actor.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  )
}
