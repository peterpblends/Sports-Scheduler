import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { MembersManager } from '@/components/app-forms'
import { PageHeader } from '@/components/ui'

export default async function MembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  // Viewing the member list needs `member:read`; anyone without it gets a 404.
  const { actor, role, orgId, orgName } = await requireOrgAccess(orgSlug, 'member:read')

  return (
    <>
      <PageHeader
        title="Members"
        subtitle={`Who has access to ${orgName}, and at what role.`}
      />
      <MembersManager
        orgId={orgId}
        currentUserId={actor.userId}
        canManage={can(role, 'member:update_role') && can(role, 'member:invite')}
      />
    </>
  )
}
