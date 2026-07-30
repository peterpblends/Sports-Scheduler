import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure, InlineSelect, RemoveButton } from '@/components/crud-forms'
import { formatCalendarDate } from '@/lib/time'

export default async function SeasonPage({
  params,
}: {
  params: Promise<{ orgSlug: string; seasonId: string }>
}) {
  const { orgSlug, seasonId } = await params
  const { role, orgId } = await requireOrgAccess(orgSlug, 'structure:read')
  const canEditStructure = can(role, 'structure:write')
  const canEditRoster = can(role, 'roster:write')

  // Scoped to the org through the league, so a season id from another tenant 404s.
  const season = await prisma.season.findFirst({
    where: { id: seasonId, deletedAt: null, league: { orgId, deletedAt: null } },
    include: {
      league: true,
      divisions: {
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
        include: {
          teams: {
            where: { deletedAt: null },
            orderBy: { name: 'asc' },
            include: {
              preferredVenue: { select: { name: true } },
              _count: { select: { memberships: { where: { deletedAt: null } } } },
            },
          },
        },
      },
    },
  })
  if (!season) notFound()

  const venues = await prisma.venue.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })

  return (
    <>
      <PageHeader
        title={`${season.league.name} · ${season.name}`}
        subtitle={`${formatCalendarDate(season.startDate)} → ${formatCalendarDate(season.endDate)} · ${season.league.sport}`}
        action={
          canEditStructure ? (
            <InlineSelect
              endpoint={`/api/orgs/${orgId}/seasons/${season.id}`}
              name="status"
              value={season.status}
              options={[
                { value: 'draft', label: 'draft' },
                { value: 'active', label: 'active' },
                { value: 'archived', label: 'archived' },
              ]}
            />
          ) : (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-900">
              {season.status}
            </span>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link href={`/app/${orgSlug}/leagues`} className="text-ink-500 hover:underline dark:text-ink-300">
          ← All leagues
        </Link>
        <span className="flex flex-wrap items-center gap-4">
          {can(role, 'schedule:read') && (
            <Link
              href={`/app/${orgSlug}/seasons/${seasonId}/versions`}
              className="text-ink-500 hover:underline dark:text-ink-300"
            >
              Version history
            </Link>
          )}
          {can(role, 'schedule:generate') && (
            <Link
              href={`/app/${orgSlug}/seasons/${seasonId}/generate`}
              className="font-medium text-turf-600 hover:underline"
            >
              Generate schedule →
            </Link>
          )}
        </span>
      </div>

      {canEditStructure && (
        <Card className="mb-6">
          <h2 className="mb-4 text-base font-semibold">New division</h2>
          <CreateForm
            endpoint={`/api/orgs/${orgId}/divisions`}
            fixed={{ seasonId: season.id }}
            submitLabel="Create division"
            fields={[
              { name: 'name', label: 'Name', required: true, placeholder: 'U12 Boys' },
              { name: 'description', label: 'Description' },
            ]}
          />
        </Card>
      )}

      {season.divisions.length === 0 ? (
        <EmptyState>No divisions yet. Add one to start placing teams.</EmptyState>
      ) : (
        <div className="space-y-4">
          {season.divisions.map((division) => (
            <Card key={division.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{division.name}</h2>
                  <p className="text-sm text-ink-500 dark:text-ink-300">
                    {division.teams.length} team{division.teams.length === 1 ? '' : 's'}
                    {division.teams.length % 2 === 1 && division.teams.length > 0 && (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                        odd count — each round needs a bye
                      </span>
                    )}
                    {division.description ? ` · ${division.description}` : ''}
                  </p>
                </div>
                {canEditStructure && (
                  <RemoveButton
                    endpoint={`/api/orgs/${orgId}/divisions/${division.id}`}
                    confirmText={`Remove ${division.name}?`}
                  />
                )}
              </div>

              {division.teams.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                      <tr>
                        <th className="pb-2 pr-4 font-medium">Team</th>
                        <th className="pb-2 pr-4 font-medium">Roster</th>
                        <th className="pb-2 pr-4 font-medium">Home preference</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                      {division.teams.map((team) => (
                        <tr key={team.id}>
                          <td className="py-2 pr-4">
                            <span className="inline-flex items-center gap-2">
                              <span
                                aria-hidden
                                className="inline-block h-3 w-3 rounded-full border border-ink-300 dark:border-ink-600"
                                style={{ background: team.primaryColor ?? 'transparent' }}
                              />
                              <Link
                                href={`/app/${orgSlug}/teams/${team.id}`}
                                className="font-medium text-turf-600 hover:underline"
                              >
                                {team.name}
                              </Link>
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-ink-600 dark:text-ink-300">
                            {team._count.memberships}
                          </td>
                          <td className="py-2 pr-4 text-ink-600 dark:text-ink-300">
                            {team.preferredVenue?.name ?? '—'}
                          </td>
                          <td className="py-2 text-right">
                            {canEditRoster && (
                              <RemoveButton
                                endpoint={`/api/orgs/${orgId}/teams/${team.id}`}
                                confirmText={`Remove ${team.name}?`}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {canEditRoster && (
                <div className="mt-4">
                  <Disclosure summary="+ Add a team">
                    <CreateForm
                      endpoint={`/api/orgs/${orgId}/teams`}
                      fixed={{ divisionId: division.id }}
                      submitLabel="Create team"
                      fields={[
                        { name: 'name', label: 'Name', required: true },
                        { name: 'primaryColor', label: 'Primary colour', type: 'color', defaultValue: '#1b7f3a' },
                        { name: 'secondaryColor', label: 'Secondary colour', type: 'color', defaultValue: '#ffffff' },
                        {
                          name: 'preferredVenueId',
                          label: 'Home venue preference',
                          type: 'select',
                          options: venues.map((v) => ({ value: v.id, label: v.name })),
                        },
                        { name: 'contactName', label: 'Contact name' },
                        { name: 'contactEmail', label: 'Contact email', type: 'email' },
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
