import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Card, EmptyState, EntityImage, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure } from '@/components/crud-forms'
import { DAY_NAMES, formatCalendarDate, formatTimeOfDay } from '@/lib/time'

export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ q?: string }>
}) {
  const { orgSlug } = await params
  const { q } = await searchParams
  const { role, orgId } = await requireOrgAccess(orgSlug, 'roster:read')
  const editable = can(role, 'roster:write')
  const canSeeOfficials = can(role, 'official:read')

  const search = q?.trim()

  const [people, referees, totalPeople] = await Promise.all([
    prisma.person.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 100,
      include: {
        referee: { select: { id: true, deletedAt: true } },
        teamMemberships: {
          where: { deletedAt: null },
          select: { role: true, team: { select: { id: true, name: true } } },
        },
      },
    }),
    canSeeOfficials
      ? prisma.referee.findMany({
          where: { deletedAt: null, person: { orgId, deletedAt: null } },
          orderBy: { person: { name: 'asc' } },
          include: {
            person: { select: { id: true, name: true, photoUrl: true } },
            availability: { where: { deletedAt: null }, orderBy: [{ kind: 'asc' }, { dayOfWeek: 'asc' }] },
            _count: { select: { assignments: { where: { deletedAt: null } } } },
          },
        })
      : Promise.resolve([]),
    prisma.person.count({ where: { orgId, deletedAt: null } }),
  ])

  const nonReferees = people.filter((p) => !p.referee || p.referee.deletedAt)

  return (
    <>
      <PageHeader
        title="People"
        subtitle={`${totalPeople} in this organization. One record per person, reused across every role they hold.`}
      />

      {editable && (
        <Card className="mb-6">
          <h2 className="mb-4 text-base font-semibold">Add a person</h2>
          <CreateForm
            endpoint={`/api/orgs/${orgId}/people`}
            submitLabel="Add person"
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'email', label: 'Email', type: 'email' },
              { name: 'phone', label: 'Phone', type: 'tel' },
              { name: 'dob', label: 'Date of birth', type: 'date' },
            ]}
          />
        </Card>
      )}

      <Card className="mb-6">
        <form className="flex flex-wrap items-end gap-3" action={`/app/${orgSlug}/people`}>
          <div className="min-w-56 flex-1">
            <label htmlFor="q" className="mb-1.5 block text-sm font-medium">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={search ?? ''}
              placeholder="Name or email"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium dark:border-ink-600 dark:bg-ink-800"
          >
            Search
          </button>
        </form>
      </Card>

      {canSeeOfficials && (
        <Card className="mb-6">
          <h2 className="text-base font-semibold">
            Officials
            <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
              {referees.length}
            </span>
          </h2>

          {referees.length === 0 ? (
            <div className="mt-4">
              <EmptyState>No officials registered yet.</EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Level</th>
                    <th className="pb-2 pr-4 font-medium">Rate</th>
                    <th className="pb-2 pr-4 font-medium">Cap/day</th>
                    <th className="pb-2 pr-4 font-medium">Availability</th>
                    <th className="pb-2 font-medium">Games</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                  {referees.map((referee) => {
                    const weekly = referee.availability.filter((a) => a.kind === 'weekly')
                    const blackouts = referee.availability.filter((a) => a.kind === 'blackout')
                    return (
                      <tr key={referee.id}>
                        <td className="py-2 pr-4">
                          <Link
                            href={`/app/${orgSlug}/people/${referee.person.id}`}
                            className="flex items-center gap-2 font-medium text-turf-600 hover:underline"
                          >
                            <EntityImage src={referee.person.photoUrl} name={referee.person.name} size={24} />
                            {referee.person.name}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-ink-600 dark:text-ink-300">
                          {referee.certificationLevel ?? '—'}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink-600 dark:text-ink-300">
                          {referee.payRateCents === null
                            ? '—'
                            : `$${(referee.payRateCents / 100).toFixed(2)}`}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink-600 dark:text-ink-300">
                          {referee.maxGamesPerDay}
                        </td>
                        <td className="py-2 pr-4 text-xs text-ink-500 dark:text-ink-400">
                          {weekly.length === 0 ? (
                            <span>no window declared</span>
                          ) : (
                            weekly.map((a) => (
                              <div key={a.id}>
                                {DAY_NAMES[a.dayOfWeek ?? 0]}s {formatTimeOfDay(a.startMinute ?? 0)}–
                                {formatTimeOfDay(a.endMinute ?? 0)}
                              </div>
                            ))
                          )}
                          {blackouts.length > 0 && (
                            <div className="mt-1 text-amber-700 dark:text-amber-300">
                              {blackouts.length} blackout{blackouts.length === 1 ? '' : 's'}
                              {blackouts[0]?.effectiveFrom && (
                                <> from {formatCalendarDate(blackouts[0].effectiveFrom)}</>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 tabular-nums text-ink-600 dark:text-ink-300">
                          {referee._count.assignments}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {editable && nonReferees.length > 0 && (
            <div className="mt-4">
              <Disclosure summary="+ Register someone as an official">
                <CreateForm
                  endpoint={`/api/orgs/${orgId}/referees`}
                  submitLabel="Register"
                  fields={[
                    {
                      name: 'personId',
                      label: 'Person',
                      type: 'select',
                      required: true,
                      options: nonReferees.map((p) => ({ value: p.id, label: p.name })),
                    },
                    { name: 'certificationLevel', label: 'Certification', placeholder: 'Grade 7' },
                    {
                      name: 'payRateCents',
                      label: 'Rate (cents)',
                      type: 'number',
                      numeric: true,
                      placeholder: '4500',
                      help: 'Stored as integer cents.',
                    },
                    {
                      name: 'maxGamesPerDay',
                      label: 'Max games/day',
                      type: 'number',
                      numeric: true,
                      defaultValue: '3',
                    },
                  ]}
                />
              </Disclosure>
            </div>
          )}
        </Card>
      )}

      <Card>
        <h2 className="text-base font-semibold">
          {search ? `Matching “${search}”` : 'Everyone'}
          <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
            showing {people.length}
          </span>
        </h2>

        {people.length === 0 ? (
          <div className="mt-4">
            <EmptyState>Nobody found.</EmptyState>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Name</th>
                  <th className="pb-2 pr-4 font-medium">Contact</th>
                  <th className="pb-2 pr-4 font-medium">Teams</th>
                  <th className="pb-2 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {people.map((person) => (
                  <tr key={person.id}>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/app/${orgSlug}/people/${person.id}`}
                        className="flex items-center gap-2 font-medium text-turf-600 hover:underline"
                      >
                        <EntityImage src={person.photoUrl} name={person.name} size={24} />
                        {person.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-500 dark:text-ink-400">
                      {person.email ?? person.phone ?? '—'}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {person.teamMemberships.length === 0 ? (
                        <span className="text-ink-500 dark:text-ink-400">—</span>
                      ) : (
                        person.teamMemberships.map((m) => (
                          <div key={`${m.team.id}-${m.role}`}>
                            {m.team.name} <span className="text-ink-500 dark:text-ink-400">({m.role})</span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="py-2 text-xs">
                      {person.referee && !person.referee.deletedAt && (
                        <span className="mr-1 rounded-full bg-cyan-500/15 px-2 py-0.5 text-cyan-700 dark:text-cyan-300">
                          official
                        </span>
                      )}
                      {person.userId && (
                        <span className="mr-1 rounded-full bg-turf-500/15 px-2 py-0.5 text-turf-700 dark:text-turf-500">
                          has login
                        </span>
                      )}
                      {person.hasConflictOfInterest && (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                          conflict
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
