import { requireOrgAccess } from '@/lib/auth-server'
import { PageHeader } from '@/components/ui'
import { ActivityFeed } from '@/components/activity-feed'

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const { orgId, orgName } = await requireOrgAccess(orgSlug, 'audit:read')

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle={`Every change recorded in ${orgName}, newest first. The log is append-only — nothing here is ever edited or removed.`}
      />
      <ActivityFeed orgId={orgId} />
    </>
  )
}
