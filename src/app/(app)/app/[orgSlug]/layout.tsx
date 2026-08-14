import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireActor } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { refereeForUser, staffTeams } from '@/lib/scope'
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

  const { role, orgId } = membership

  /**
   * Own-scope context for the nav, resolved from the session.
   *
   * A coach's teams and a referee's own record are what make the nav *theirs*
   * rather than a generic list of everything the app can do. Both are looked up by
   * user id — never from the URL — for the same reason every `:own` check is.
   */
  const [ownTeams, ownReferee] = await Promise.all([
    can(role, 'roster:write:own') ? staffTeams(actor.userId, orgId) : Promise.resolve([]),
    can(role, 'official:read:own') ? refereeForUser(actor.userId, orgId) : Promise.resolve(null),
  ])

  // A referee's outstanding answers, surfaced in the nav because it is the one
  // thing in this app that somebody else is actively blocked on.
  const awaitingAnswer = ownReferee
    ? await prisma.gameOfficial.count({
        where: {
          refereeId: ownReferee.id,
          status: 'pending',
          deletedAt: null,
          game: {
            deletedAt: null,
            startTime: { gte: new Date() },
            season: { deletedAt: null, league: { orgId, deletedAt: null } },
          },
        },
      })
    : 0

  /**
   * Nav is filtered by the same permission matrix the server enforces, and ordered
   * by what the role actually came here to do. Hiding a link is a convenience, not
   * the control — every endpoint re-checks, which is what the coach and referee
   * tests assert directly against the API.
   *
   * The ordering is the substance of this list. A referee's own board outranks the
   * full schedule; a coach's own team outranks the league structure. An org-wide
   * People tab is left to roles that can actually edit an org-wide roster — a coach
   * edits theirs from their team page, so the tab was only ever a dead end for them.
   */
  const nav = [
    { href: `/app/${orgSlug}`, label: 'Dashboard', show: true, badge: 0 },
    {
      href: `/app/${orgSlug}/officiating`,
      label: 'My games',
      show: ownReferee !== null,
      badge: awaitingAnswer,
    },
    ...ownTeams.map((team) => ({
      href: `/app/${orgSlug}/teams/${team.id}`,
      label: ownTeams.length === 1 ? 'My team' : team.name,
      show: true,
      badge: 0,
    })),
    {
      href: `/app/${orgSlug}/schedule`,
      label: 'Schedule',
      show: can(role, 'schedule:read:published'),
      badge: 0,
    },
    {
      href: `/app/${orgSlug}/schedule/officials`,
      label: 'Officiating',
      show: can(role, 'official:assign'),
      badge: 0,
    },
    {
      href: `/app/${orgSlug}/leagues`,
      label: 'Leagues',
      show: can(role, 'structure:read'),
      badge: 0,
    },
    { href: `/app/${orgSlug}/venues`, label: 'Venues', show: can(role, 'venue:read'), badge: 0 },
    {
      href: `/app/${orgSlug}/people`,
      label: 'People',
      show: can(role, 'roster:write'),
      badge: 0,
    },
    { href: `/app/${orgSlug}/members`, label: 'Members', show: can(role, 'member:read'), badge: 0 },
    { href: `/app/${orgSlug}/activity`, label: 'Activity', show: can(role, 'audit:read'), badge: 0 },
    {
      href: `/app/${orgSlug}/subscriptions`,
      label: 'Alerts',
      show: can(role, 'schedule:read:published'),
      badge: 0,
    },
    { href: `/app/${orgSlug}/setup`, label: 'Setup', show: can(role, 'structure:write'), badge: 0 },
    { href: '/account', label: 'Account', show: true, badge: 0 },
  ].filter((item) => item.show)

  const otherOrgs = actor.memberships.filter((m) => m.orgSlug !== orgSlug)

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-800">
        <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link
              href="/app"
              className="inline-flex items-center py-1 text-sm font-semibold uppercase tracking-widest text-turf-600"
            >
              Sports Scheduler
            </Link>

            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{membership.orgName}</span>
              <RoleBadge role={role} />
            </div>

            {/* Desktop nav: a plain row, visible from md up. Below md it collapses into
                the <details> drawer below so 12 links don't wrap across half the
                screen before any page content appears. */}
            <nav className="hidden items-center gap-x-4 gap-y-2 text-sm md:flex">
              {nav.map((item) => (
                <NavLink key={item.href} item={item} />
              ))}
            </nav>

            <div className="ml-auto hidden items-center gap-4 md:flex">
              {otherOrgs.length > 0 && (
                // Switching org is plain navigation, so links keep this a server component.
                <div className="flex items-center gap-2 text-sm">
                  {otherOrgs.map((m) => (
                    <Link
                      key={m.orgId}
                      href={`/app/${m.orgSlug}`}
                      className="inline-flex items-center py-2 text-ink-500 hover:text-turf-600 dark:text-ink-300"
                    >
                      {m.orgName}
                    </Link>
                  ))}
                </div>
              )}
              <span className="text-sm text-ink-500 dark:text-ink-300">{actor.email}</span>
              <SignOutButton />
            </div>

            {/* Mobile menu toggle. A native <details>/<summary> disclosure needs no
                client JS, matching the pattern already used by the quick-start guide.
                `w-full` on the <details> itself matters: without it the element sizes
                to its collapsed summary, and the opened list inherits that width —
                indented into the right half of the screen instead of running edge to
                edge, with the summary's own alignment left to `flex justify-end`. */}
            <details className="w-full md:hidden">
              <summary className="ml-auto flex min-h-11 w-fit min-w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-ink-300 px-3 text-sm font-medium text-ink-700 marker:hidden dark:border-ink-600 dark:text-ink-100 [&::-webkit-details-marker]:hidden">
                Menu
              </summary>
              <nav className="mt-3 flex flex-col gap-1 border-t border-ink-200 pt-3 text-sm dark:border-ink-700">
                {nav.map((item) => (
                  <NavLink key={item.href} item={item} block />
                ))}
                {otherOrgs.length > 0 && (
                  <div className="mt-2 border-t border-ink-200 pt-2 dark:border-ink-700">
                    <p className="px-1 py-1 text-xs font-medium uppercase tracking-wide text-ink-400">
                      Switch organization
                    </p>
                    {otherOrgs.map((m) => (
                      <Link
                        key={m.orgId}
                        href={`/app/${m.orgSlug}`}
                        className="flex min-h-11 items-center px-1 py-2 text-ink-600 hover:text-turf-600 dark:text-ink-300"
                      >
                        {m.orgName}
                      </Link>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between border-t border-ink-200 pt-2 dark:border-ink-700">
                  <span className="px-1 text-xs text-ink-500 dark:text-ink-300">{actor.email}</span>
                  <SignOutButton />
                </div>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  )
}

function NavLink({
  item,
  block = false,
}: {
  item: { href: string; label: string; badge: number }
  block?: boolean
}) {
  return (
    <Link
      href={item.href}
      className={
        block
          ? 'flex min-h-11 items-center gap-1.5 px-1 py-2 text-ink-600 hover:text-turf-600 dark:text-ink-300'
          : 'inline-flex items-center gap-1.5 py-2 text-ink-600 hover:text-turf-600 dark:text-ink-300'
      }
    >
      {item.label}
      {item.badge > 0 && (
        <span
          className="rounded-full bg-amber-500/20 px-1.5 text-xs font-medium tabular-nums text-amber-800 dark:text-amber-200"
          aria-label={`${item.badge} waiting on you`}
        >
          {item.badge}
        </span>
      )}
    </Link>
  )
}
