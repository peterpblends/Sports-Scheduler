import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { PERMISSIONS, ROLE_DESCRIPTIONS, can } from '@/lib/authz'
import { Card, PageHeader, RoleBadge } from '@/components/ui'

export default async function OrgDashboard({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const { role, orgId, orgName, actor } = await requireOrgAccess(orgSlug, 'org:read')

  // Membership counts are administrative, so they are gated the same way the
  // members page is rather than shown to everyone in the org.
  const showMemberStats = can(role, 'member:read')

  const [org, memberCount, pendingInvites, recentActivity] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    showMemberStats
      ? prisma.membership.count({ where: { orgId, deletedAt: null } })
      : Promise.resolve(null),
    showMemberStats
      ? prisma.invitation.count({
          where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        })
      : Promise.resolve(null),
    can(role, 'audit:read')
      ? prisma.auditEvent.findMany({
          where: { orgId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })
      : Promise.resolve([]),
  ])

  return (
    <>
      <PageHeader
        title={orgName}
        subtitle={`Signed in as ${actor.email} · time zone ${org.timezone}`}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {showMemberStats && (
          <>
            <Card>
              <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                Members
              </div>
              <div className="mt-1 text-3xl font-semibold">{memberCount}</div>
              <Link
                href={`/app/${orgSlug}/members`}
                className="mt-2 inline-block text-sm text-turf-600 hover:underline"
              >
                Manage members
              </Link>
            </Card>
            <Card>
              <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                Pending invitations
              </div>
              <div className="mt-1 text-3xl font-semibold">{pendingInvites}</div>
            </Card>
          </>
        )}
        <Card>
          <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">Your role</div>
          <div className="mt-2">
            <RoleBadge role={role} />
          </div>
          <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">{ROLE_DESCRIPTIONS[role]}</p>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold">What your role can do here</h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            The same list the server checks on every request.
          </p>
          <ul className="mt-4 flex flex-wrap gap-1.5">
            {[...PERMISSIONS[role]].sort().map((p) => (
              <li
                key={p}
                className="rounded bg-ink-100 px-2 py-0.5 font-mono text-xs text-ink-600 dark:bg-ink-900 dark:text-ink-300"
              >
                {p}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-base font-semibold">Recent activity</h2>
          {can(role, 'audit:read') ? (
            recentActivity.length === 0 ? (
              <p className="mt-4 text-sm text-ink-500 dark:text-ink-300">Nothing recorded yet.</p>
            ) : (
              <ul className="mt-4 divide-y divide-ink-200 text-sm dark:divide-ink-700">
                {recentActivity.map((event) => (
                  <li key={event.id} className="py-2">
                    <div className="font-mono text-xs text-turf-600">{event.action}</div>
                    <div className="text-ink-600 dark:text-ink-300">
                      {event.actorLabel} · {event.entityType}
                    </div>
                    <div className="text-xs text-ink-500 dark:text-ink-400">
                      {event.createdAt.toISOString()}
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="mt-4 text-sm text-ink-500 dark:text-ink-300">
              Your role cannot read the activity log.
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Next up</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Phase 1 covers accounts, organizations, roles and invitations. Leagues, seasons, teams, venues
          and the scheduling engine arrive in the following phases.
        </p>
      </Card>
    </>
  )
}
