import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, EmptyState, EntityImage, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure, RemoveButton } from '@/components/crud-forms'
import { DAY_NAMES, formatCalendarDate, formatTimeOfDay } from '@/lib/time'

export default async function PersonPage({
  params,
}: {
  params: Promise<{ orgSlug: string; personId: string }>
}) {
  const { orgSlug, personId } = await params
  const { role, orgId } = await requireOrgAccess(orgSlug, 'roster:read')
  const editable = can(role, 'roster:write')

  const person = await prisma.person.findFirst({
    where: { id: personId, orgId, deletedAt: null },
    include: {
      user: { select: { email: true } },
      referee: {
        include: {
          availability: {
            where: { deletedAt: null },
            orderBy: [{ kind: 'asc' }, { dayOfWeek: 'asc' }, { effectiveFrom: 'asc' }],
          },
          preferredVenues: { select: { id: true, name: true } },
        },
      },
      teamMemberships: {
        where: { deletedAt: null },
        include: {
          team: { select: { id: true, name: true, division: { select: { name: true } } } },
        },
      },
      relationships: {
        where: { deletedAt: null },
        include: { relatedPerson: { select: { id: true, name: true } } },
      },
    },
  })
  if (!person) notFound()

  const referee = person.referee && !person.referee.deletedAt ? person.referee : null
  const otherPeople = await prisma.person.findMany({
    where: { orgId, deletedAt: null, id: { not: personId } },
    orderBy: { name: 'asc' },
    take: 300,
    select: { id: true, name: true },
  })

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <EntityImage src={person.photoUrl} name={person.name} size={40} />
            {person.name}
          </span>
        }
        subtitle={[person.email, person.phone].filter(Boolean).join(' · ') || 'No contact details'}
      />

      <p className="mb-6 text-sm">
        <Link href={`/app/${orgSlug}/people`} className="text-ink-500 hover:underline dark:text-ink-300">
          ← All people
        </Link>
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold">Details</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Date of birth</dt>
              <dd>{person.dob ? formatCalendarDate(person.dob) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Linked login</dt>
              <dd>{person.user?.email ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500 dark:text-ink-400">Conflict of interest</dt>
              <dd>{person.hasConflictOfInterest ? (person.conflictNote ?? 'flagged') : 'no'}</dd>
            </div>
          </dl>
          {person.notes && (
            <p className="mt-3 border-t border-ink-200 pt-3 text-sm text-ink-600 dark:border-ink-700 dark:text-ink-300">
              {person.notes}
            </p>
          )}

          {editable && (
            <div className="mt-4">
              <Disclosure summary="Edit details">
                <CreateForm
                  endpoint={`/api/orgs/${orgId}/people/${personId}`}
                  method="PATCH"
                  submitLabel="Save"
                  layout="stacked"
                  fields={[
                    { name: 'name', label: 'Name', required: true, defaultValue: person.name },
                    { name: 'email', label: 'Email', type: 'email', defaultValue: person.email ?? '' },
                    { name: 'phone', label: 'Phone', type: 'tel', defaultValue: person.phone ?? '' },
                    {
                      name: 'photoUrl',
                      label: 'Photo URL',
                      type: 'url',
                      defaultValue: person.photoUrl ?? '',
                      placeholder: 'https://example.com/photo.jpg',
                      help: 'Optional — a link to an image you already host somewhere. Never shown on the public schedule page.',
                    },
                    {
                      name: 'notes',
                      label: 'Notes',
                      type: 'textarea',
                      defaultValue: person.notes ?? '',
                    },
                    {
                      name: 'conflictNote',
                      label: 'Conflict note',
                      defaultValue: person.conflictNote ?? '',
                      help: 'Filling this in does not by itself set the flag; relationships below drive the scheduler.',
                    },
                  ]}
                />
              </Disclosure>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold">Teams</h2>
          {person.teamMemberships.length === 0 ? (
            <div className="mt-3">
              <EmptyState>Not on any team.</EmptyState>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {person.teamMemberships.map((membership) => (
                <li key={membership.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <Link
                      href={`/app/${orgSlug}/teams/${membership.team.id}`}
                      className="font-medium text-turf-600 hover:underline"
                    >
                      {membership.team.name}
                    </Link>
                    <div className="text-xs text-ink-500 dark:text-ink-400">
                      {membership.team.division.name} · {membership.role}
                      {membership.jerseyNumber ? ` · #${membership.jerseyNumber}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold">Family links</h2>
          <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
            Used to keep officials off games involving relatives, and to keep siblings&apos; games close
            together.
          </p>
          {person.relationships.length === 0 ? (
            <div className="mt-3">
              <EmptyState>No links recorded.</EmptyState>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {person.relationships.map((relationship) => (
                <li key={relationship.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <Link
                      href={`/app/${orgSlug}/people/${relationship.relatedPerson.id}`}
                      className="font-medium text-turf-600 hover:underline"
                    >
                      {relationship.relatedPerson.name}
                    </Link>
                    <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                      {relationship.kind}
                    </span>
                  </span>
                  {editable && (
                    <RemoveButton
                      endpoint={`/api/orgs/${orgId}/people/${personId}/relationships?relatedPersonId=${relationship.relatedPerson.id}`}
                      label="×"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {editable && (
            <div className="mt-4">
              <Disclosure summary="+ Link a relative">
                <CreateForm
                  endpoint={`/api/orgs/${orgId}/people/${personId}/relationships`}
                  submitLabel="Link"
                  fields={[
                    {
                      name: 'relatedPersonId',
                      label: 'Person',
                      type: 'select',
                      required: true,
                      options: otherPeople.map((p) => ({ value: p.id, label: p.name })),
                    },
                    {
                      name: 'kind',
                      label: 'Relationship',
                      type: 'select',
                      required: true,
                      defaultValue: 'family',
                      options: [
                        { value: 'family', label: 'family' },
                        { value: 'guardian', label: 'guardian' },
                        { value: 'other', label: 'other' },
                      ],
                    },
                  ]}
                />
              </Disclosure>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold">Officiating</h2>
          {!referee ? (
            <div className="mt-3">
              <EmptyState>Not registered as an official.</EmptyState>
            </div>
          ) : (
            <>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500 dark:text-ink-400">Certification</dt>
                  <dd>{referee.certificationLevel ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500 dark:text-ink-400">Rate</dt>
                  <dd className="tabular-nums">
                    {referee.payRateCents === null
                      ? '—'
                      : `$${(referee.payRateCents / 100).toFixed(2)} per game`}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500 dark:text-ink-400">Max games per day</dt>
                  <dd className="tabular-nums">{referee.maxGamesPerDay}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500 dark:text-ink-400">Travel buffer</dt>
                  <dd className="tabular-nums">{referee.travelBufferMinutes} min</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500 dark:text-ink-400">Preferred venues</dt>
                  <dd>{referee.preferredVenues.map((v) => v.name).join(', ') || '—'}</dd>
                </div>
              </dl>

              <h3 className="mt-4 text-sm font-semibold">Availability</h3>
              {referee.availability.length === 0 ? (
                <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
                  No windows declared — treated as no stated restriction.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {referee.availability.map((slot) => (
                    <li key={slot.id} className="flex items-center justify-between gap-3">
                      <span>
                        {slot.kind === 'weekly' ? (
                          <>
                            <span className="font-medium">{DAY_NAMES[slot.dayOfWeek ?? 0]}s</span>{' '}
                            {formatTimeOfDay(slot.startMinute ?? 0)}–{formatTimeOfDay(slot.endMinute ?? 0)}
                            <span className="ml-1 text-xs text-ink-500 dark:text-ink-400">local</span>
                          </>
                        ) : (
                          <>
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                              blackout
                            </span>{' '}
                            {slot.effectiveFrom && formatCalendarDate(slot.effectiveFrom)}
                            {slot.effectiveTo &&
                              slot.effectiveFrom &&
                              slot.effectiveTo.getTime() !== slot.effectiveFrom.getTime() &&
                              ` → ${formatCalendarDate(slot.effectiveTo)}`}
                            {slot.reason && (
                              <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                                {slot.reason}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                      {editable && (
                        <RemoveButton
                          endpoint={`/api/orgs/${orgId}/referees/${referee.id}/availability/${slot.id}`}
                          label="×"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {editable && (
                <div className="mt-4 space-y-3">
                  <Disclosure summary="+ Weekly availability">
                    <CreateForm
                      endpoint={`/api/orgs/${orgId}/referees/${referee.id}/availability`}
                      submitLabel="Add window"
                      fixed={{ kind: 'weekly' }}
                      fields={[
                        {
                          name: 'dayOfWeek',
                          label: 'Day',
                          type: 'select',
                          required: true,
                          numeric: true,
                          defaultValue: '6',
                          options: DAY_NAMES.map((day, index) => ({
                            value: String(index),
                            label: day,
                          })),
                        },
                        { name: 'startTime', label: 'From', type: 'time', required: true, defaultValue: '08:00' },
                        { name: 'endTime', label: 'To', type: 'time', required: true, defaultValue: '14:00' },
                      ]}
                    />
                  </Disclosure>
                  <Disclosure summary="+ Blackout dates">
                    <CreateForm
                      endpoint={`/api/orgs/${orgId}/referees/${referee.id}/availability`}
                      submitLabel="Add blackout"
                      fixed={{ kind: 'blackout' }}
                      fields={[
                        { name: 'startDate', label: 'From', type: 'date', required: true },
                        { name: 'endDate', label: 'To', type: 'date', required: true },
                        { name: 'reason', label: 'Reason' },
                      ]}
                    />
                  </Disclosure>
                </div>
              )}
            </>
          )}

          {!referee && editable && (
            <div className="mt-4">
              <Disclosure summary="+ Register as an official">
                <CreateForm
                  endpoint={`/api/orgs/${orgId}/referees`}
                  submitLabel="Register"
                  fixed={{ personId }}
                  fields={[
                    { name: 'certificationLevel', label: 'Certification', placeholder: 'Grade 7' },
                    {
                      name: 'payRateCents',
                      label: 'Rate (cents)',
                      type: 'number',
                      numeric: true,
                      placeholder: '4500',
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
      </div>

      {person.hasConflictOfInterest && (
        <div className="mt-6">
          <Alert kind="info">
            This person is flagged for conflicts of interest. The scheduler refuses officiating
            assignments that touch it.
          </Alert>
        </div>
      )}
    </>
  )
}
