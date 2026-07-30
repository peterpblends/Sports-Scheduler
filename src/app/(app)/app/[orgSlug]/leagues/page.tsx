import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure, RemoveButton } from '@/components/crud-forms'
import { formatCalendarDate } from '@/lib/time'

export default async function LeaguesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const { role, orgId } = await requireOrgAccess(orgSlug, 'structure:read')
  const editable = can(role, 'structure:write')

  const leagues = await prisma.league.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { name: 'asc' },
    include: {
      seasons: {
        where: { deletedAt: null },
        orderBy: { startDate: 'desc' },
        include: {
          _count: { select: { divisions: { where: { deletedAt: null } } } },
        },
      },
    },
  })

  return (
    <>
      <PageHeader
        title="Leagues and seasons"
        subtitle="A league holds seasons; a season holds divisions, which hold teams."
      />

      {editable && (
        <Card className="mb-6">
          <h2 className="mb-4 text-base font-semibold">New league</h2>
          <CreateForm
            endpoint={`/api/orgs/${orgId}/leagues`}
            submitLabel="Create league"
            fields={[
              { name: 'name', label: 'Name', required: true, placeholder: 'Recreational' },
              { name: 'sport', label: 'Sport', defaultValue: 'soccer', required: true },
              { name: 'description', label: 'Description' },
            ]}
          />
        </Card>
      )}

      {leagues.length === 0 ? (
        <EmptyState>No leagues yet.</EmptyState>
      ) : (
        <div className="space-y-4">
          {leagues.map((league) => (
            <Card key={league.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{league.name}</h2>
                  <p className="text-sm text-ink-500 dark:text-ink-300">
                    {league.sport}
                    {league.description ? ` · ${league.description}` : ''}
                  </p>
                </div>
                {editable && (
                  <RemoveButton
                    endpoint={`/api/orgs/${orgId}/leagues/${league.id}`}
                    confirmText={`Remove ${league.name}? Its seasons stay in history and can be restored.`}
                  />
                )}
              </div>

              <ul className="mt-4 divide-y divide-ink-200 text-sm dark:divide-ink-700">
                {league.seasons.length === 0 && (
                  <li className="py-2 text-ink-500 dark:text-ink-400">No seasons yet.</li>
                )}
                {league.seasons.map((season) => (
                  <li key={season.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <div>
                      <Link
                        href={`/app/${orgSlug}/seasons/${season.id}`}
                        className="font-medium text-turf-600 hover:underline"
                      >
                        {season.name}
                      </Link>
                      <div className="text-xs text-ink-500 dark:text-ink-400">
                        {formatCalendarDate(season.startDate)} → {formatCalendarDate(season.endDate)} ·{' '}
                        {season._count.divisions} division{season._count.divisions === 1 ? '' : 's'}
                      </div>
                    </div>
                    <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-900">
                      {season.status}
                    </span>
                  </li>
                ))}
              </ul>

              {editable && (
                <div className="mt-4">
                  <Disclosure summary="+ Add a season">
                    <CreateForm
                      endpoint={`/api/orgs/${orgId}/seasons`}
                      fixed={{ leagueId: league.id }}
                      submitLabel="Create season"
                      fields={[
                        { name: 'name', label: 'Name', required: true, placeholder: 'Spring 2026' },
                        { name: 'startDate', label: 'Start', type: 'date', required: true },
                        { name: 'endDate', label: 'End', type: 'date', required: true },
                        {
                          name: 'status',
                          label: 'Status',
                          type: 'select',
                          required: true,
                          defaultValue: 'draft',
                          options: [
                            { value: 'draft', label: 'draft' },
                            { value: 'active', label: 'active' },
                            { value: 'archived', label: 'archived' },
                          ],
                        },
                      ]}
                    />
                  </Disclosure>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
