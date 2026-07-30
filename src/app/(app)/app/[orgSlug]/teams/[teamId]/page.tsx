import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { staffTeamIds } from '@/lib/scope'
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure, RemoveButton } from '@/components/crud-forms'
import { RosterImport } from '@/components/roster-import'

export default async function TeamPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const { actor, role, orgId } = await requireOrgAccess(orgSlug, 'roster:read')

  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      deletedAt: null,
      division: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
    },
    include: {
      division: { include: { season: { include: { league: true } } } },
      preferredVenue: { select: { id: true, name: true } },
      memberships: {
        where: { deletedAt: null },
        orderBy: [{ role: 'asc' }, { jerseyNumber: 'asc' }],
        include: { person: { select: { id: true, name: true, email: true, phone: true } } },
      },
    },
  })
  if (!team) notFound()

  /**
   * Mirrors the server rule exactly: org-wide `roster:write`, or `roster:write:own`
   * for a team this user is staff of. Hiding the controls is a courtesy — the API
   * re-checks either way.
   */
  const canEdit =
    can(role, 'roster:write') ||
    (can(role, 'roster:write:own') && (await staffTeamIds(actor.userId, orgId)).includes(teamId))

  const availablePeople = await prisma.person.findMany({
    where: {
      orgId,
      deletedAt: null,
      NOT: { teamMemberships: { some: { teamId, deletedAt: null } } },
    },
    orderBy: { name: 'asc' },
    take: 300,
    select: { id: true, name: true },
  })

  const staff = team.memberships.filter((m) => m.role !== 'player')
  const players = team.memberships.filter((m) => m.role === 'player')

  return (
    <>
      <PageHeader
        title={team.name}
        subtitle={`${team.division.season.league.name} · ${team.division.season.name} · ${team.division.name}`}
      />

      <p className="mb-6 text-sm">
        <Link
          href={`/app/${orgSlug}/seasons/${team.division.seasonId}`}
          className="text-ink-500 hover:underline dark:text-ink-300"
        >
          ← {team.division.season.name}
        </Link>
      </p>

      {!canEdit && (
        <div className="mb-6">
          <Alert kind="info">
            You can view this roster but not change it. Coaches may only edit teams they are staff of.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <h2 className="text-base font-semibold">Details</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Colours</dt>
              <dd className="flex items-center gap-1.5">
                {[team.primaryColor, team.secondaryColor].filter(Boolean).map((color) => (
                  <span
                    key={color}
                    className="inline-block h-4 w-4 rounded border border-ink-300 dark:border-ink-600"
                    style={{ background: color! }}
                    title={color!}
                  />
                ))}
                {!team.primaryColor && '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Home preference</dt>
              <dd>{team.preferredVenue?.name ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Contact</dt>
              <dd className="text-right">
                {team.contactName ?? '—'}
                {team.contactEmail && (
                  <div className="text-xs text-ink-500 dark:text-ink-400">{team.contactEmail}</div>
                )}
                {team.contactPhone && (
                  <div className="text-xs text-ink-500 dark:text-ink-400">{team.contactPhone}</div>
                )}
              </dd>
            </div>
          </dl>

          {canEdit && (
            <div className="mt-4">
              <Disclosure summary="Edit details">
                <CreateForm
                  endpoint={`/api/orgs/${orgId}/teams/${teamId}`}
                  method="PATCH"
                  submitLabel="Save"
                  layout="stacked"
                  fields={[
                    { name: 'contactName', label: 'Contact name', defaultValue: team.contactName ?? '' },
                    {
                      name: 'contactEmail',
                      label: 'Contact email',
                      type: 'email',
                      defaultValue: team.contactEmail ?? '',
                    },
                    {
                      name: 'contactPhone',
                      label: 'Contact phone',
                      type: 'tel',
                      defaultValue: team.contactPhone ?? '',
                    },
                  ]}
                />
              </Disclosure>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="text-base font-semibold">
            Roster
            <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
              {players.length} player{players.length === 1 ? '' : 's'}, {staff.length} staff
            </span>
          </h2>

          {team.memberships.length === 0 ? (
            <div className="mt-4">
              <EmptyState>Nobody on this roster yet.</EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">#</th>
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Role</th>
                    <th className="pb-2 pr-4 font-medium">Contact</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                  {[...staff, ...players].map((member) => (
                    <tr key={member.id}>
                      <td className="py-2 pr-4 tabular-nums text-ink-600 dark:text-ink-300">
                        {member.jerseyNumber ?? '—'}
                      </td>
                      <td className="py-2 pr-4">
                        <Link
                          href={`/app/${orgSlug}/people/${member.person.id}`}
                          className="font-medium text-turf-600 hover:underline"
                        >
                          {member.person.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-900">
                          {member.role}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-ink-500 dark:text-ink-400">
                        {member.person.email ?? member.person.phone ?? '—'}
                      </td>
                      <td className="py-2 text-right">
                        {canEdit && (
                          <RemoveButton
                            endpoint={`/api/orgs/${orgId}/teams/${teamId}/members/${member.id}`}
                            label="Remove"
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canEdit && (
            <div className="mt-4">
              <Disclosure summary="+ Add someone to this roster">
                <CreateForm
                  endpoint={`/api/orgs/${orgId}/teams/${teamId}/members`}
                  submitLabel="Add"
                  fields={[
                    {
                      name: 'personId',
                      label: 'Person',
                      type: 'select',
                      required: true,
                      options: availablePeople.map((p) => ({ value: p.id, label: p.name })),
                    },
                    {
                      name: 'role',
                      label: 'Role',
                      type: 'select',
                      required: true,
                      defaultValue: 'player',
                      options: [
                        { value: 'player', label: 'player' },
                        { value: 'coach', label: 'coach' },
                        { value: 'assistant', label: 'assistant' },
                        { value: 'manager', label: 'manager' },
                      ],
                    },
                    { name: 'jerseyNumber', label: 'Jersey', placeholder: '10' },
                  ]}
                />
              </Disclosure>
            </div>
          )}
        </Card>
      </div>

      <p className="mt-4 text-sm">
        <a
          href={`/api/orgs/${orgId}/teams/${teamId}/export`}
          className="text-turf-600 hover:underline"
        >
          Export this roster as CSV
        </a>
        <span className="ml-2 text-ink-500 dark:text-ink-400">
          — same columns the importer reads, so it can be edited and imported back.
        </span>
      </p>

      {canEdit && (
        <div className="mt-4">
          <RosterImport orgId={orgId} teamId={teamId} teamName={team.name} />
        </div>
      )}
    </>
  )
}
