import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, PageHeader } from '@/components/ui'
import { VersionHistory } from '@/components/versions'

export default async function VersionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; seasonId: string }>
}) {
  const { orgSlug, seasonId } = await params
  // `schedule:read` rather than `:published` — versions are the draft history, so
  // roles that can only see published schedules have no business here.
  const { role, orgId } = await requireOrgAccess(orgSlug, 'schedule:read')

  const season = await prisma.season.findFirst({
    where: { id: seasonId, deletedAt: null, league: { orgId, deletedAt: null } },
    include: {
      league: true,
      publishedVersion: { select: { number: true, label: true, publishedAt: true } },
    },
  })
  if (!season) notFound()

  return (
    <>
      <PageHeader
        title="Version history"
        subtitle={`${season.league.name} · ${season.name}`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link
          href={`/app/${orgSlug}/seasons/${seasonId}`}
          className="text-ink-500 hover:underline dark:text-ink-300"
        >
          ← {season.name}
        </Link>
        <Link
          href={`/app/${orgSlug}/seasons/${seasonId}/generate`}
          className="font-medium text-turf-600 hover:underline"
        >
          Generate schedule →
        </Link>
      </div>

      <div className="mb-6">
        {season.publishedVersion ? (
          <Alert kind="success">
            Coaches, referees and viewers currently see <strong>v{season.publishedVersion.number}</strong>{' '}
            ({season.publishedVersion.label})
            {season.publishedVersion.publishedAt &&
              `, published ${new Date(season.publishedVersion.publishedAt).toLocaleString()}`}
            . Draft changes stay invisible to them until you publish again.
            <div className="mt-2">
              Public link:{' '}
              <Link href={`/s/${orgSlug}?seasonId=${seasonId}`} className="underline">
                /s/{orgSlug}
              </Link>{' '}
              — readable with no account, and serves this version only.
            </div>
          </Alert>
        ) : (
          <Alert kind="info">
            Nothing is published for this season, so coaches, referees and viewers see no
            schedule at all. Publish a version to make it visible.
          </Alert>
        )}
      </div>

      <VersionHistory
        orgId={orgId}
        seasonId={seasonId}
        canPublish={can(role, 'schedule:publish')}
        canRestore={can(role, 'schedule:restore')}
        canSave={can(role, 'schedule:edit')}
      />
    </>
  )
}
