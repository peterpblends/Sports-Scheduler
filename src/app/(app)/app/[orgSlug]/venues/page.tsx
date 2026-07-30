import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { CreateForm, Disclosure, RemoveButton, TimeSlotForm } from '@/components/crud-forms'
import { DAY_NAMES, formatCalendarDate, formatTimeOfDay } from '@/lib/time'

const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney',
  'UTC',
]

export default async function VenuesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const { role, orgId } = await requireOrgAccess(orgSlug, 'venue:read')
  const editable = can(role, 'venue:write')

  const [venues, blackouts, divisions, teams] = await Promise.all([
    prisma.venue.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        fields: {
          where: { deletedAt: null },
          orderBy: { name: 'asc' },
          include: {
            timeSlots: {
              where: { deletedAt: null },
              orderBy: [{ dayOfWeek: 'asc' }, { specificDate: 'asc' }, { startMinute: 'asc' }],
            },
          },
        },
      },
    }),
    prisma.blackoutDate.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { startDate: 'asc' },
      include: {
        division: { select: { name: true } },
        team: { select: { name: true } },
        venue: { select: { name: true } },
      },
    }),
    prisma.division.findMany({
      where: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.team.findMany({
      where: {
        deletedAt: null,
        division: { deletedAt: null, season: { deletedAt: null, league: { orgId, deletedAt: null } } },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <>
      <PageHeader
        title="Venues and availability"
        subtitle="Fields, the local-time windows they are available, and dates nothing may be scheduled."
      />

      {editable && (
        <Card className="mb-6">
          <h2 className="mb-4 text-base font-semibold">New venue</h2>
          <CreateForm
            endpoint={`/api/orgs/${orgId}/venues`}
            submitLabel="Create venue"
            fields={[
              { name: 'name', label: 'Name', required: true, placeholder: 'Riverside Park' },
              { name: 'address', label: 'Address' },
              {
                name: 'timezone',
                label: 'Time zone',
                type: 'select',
                required: true,
                defaultValue: 'America/Los_Angeles',
                options: COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz })),
                help: 'Every game here is displayed in this zone.',
              },
            ]}
          />
        </Card>
      )}

      {venues.length === 0 ? (
        <EmptyState>No venues yet.</EmptyState>
      ) : (
        <div className="space-y-4">
          {venues.map((venue) => (
            <Card key={venue.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{venue.name}</h2>
                  <p className="text-sm text-ink-500 dark:text-ink-300">
                    {venue.address ? `${venue.address} · ` : ''}
                    <span className="font-mono text-xs">{venue.timezone}</span>
                  </p>
                  {venue.notes && (
                    <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">{venue.notes}</p>
                  )}
                </div>
                {editable && (
                  <RemoveButton
                    endpoint={`/api/orgs/${orgId}/venues/${venue.id}`}
                    confirmText={`Remove ${venue.name}?`}
                  />
                )}
              </div>

              <div className="mt-4 space-y-3">
                {venue.fields.length === 0 && (
                  <p className="text-sm text-ink-500 dark:text-ink-400">No fields yet.</p>
                )}
                {venue.fields.map((field) => (
                  <div
                    key={field.id}
                    className="rounded-lg border border-ink-200 p-3 dark:border-ink-700"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">{field.name}</h3>
                      {editable && (
                        <RemoveButton endpoint={`/api/orgs/${orgId}/fields/${field.id}`} />
                      )}
                    </div>

                    {field.timeSlots.length === 0 ? (
                      <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
                        No availability declared — treated as unconstrained.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-1 text-sm">
                        {field.timeSlots.map((slot) => (
                          <li key={slot.id} className="flex items-center justify-between gap-3">
                            <span>
                              {slot.specificDate ? (
                                <>
                                  <span className="font-medium">
                                    {formatCalendarDate(slot.specificDate)}
                                  </span>{' '}
                                  <span className="text-xs text-ink-500 dark:text-ink-400">(one-off)</span>
                                </>
                              ) : (
                                <span className="font-medium">{DAY_NAMES[slot.dayOfWeek ?? 0]}s</span>
                              )}{' '}
                              {formatTimeOfDay(slot.startMinute)}–{formatTimeOfDay(slot.endMinute)}
                              <span className="ml-1 text-xs text-ink-500 dark:text-ink-400">local</span>
                              {slot.effectiveFrom && slot.effectiveTo && (
                                <span className="ml-2 text-xs text-ink-500 dark:text-ink-400">
                                  {formatCalendarDate(slot.effectiveFrom)} →{' '}
                                  {formatCalendarDate(slot.effectiveTo)}
                                </span>
                              )}
                            </span>
                            {editable && (
                              <RemoveButton
                                endpoint={`/api/orgs/${orgId}/timeslots/${slot.id}`}
                                label="×"
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {editable && (
                      <TimeSlotForm orgId={orgId} fieldId={field.id} timezone={venue.timezone} />
                    )}
                  </div>
                ))}
              </div>

              {editable && (
                <div className="mt-4">
                  <Disclosure summary="+ Add a field">
                    <CreateForm
                      endpoint={`/api/orgs/${orgId}/venues/${venue.id}/fields`}
                      submitLabel="Add field"
                      fields={[
                        { name: 'name', label: 'Name', required: true, placeholder: 'Field 1' },
                        { name: 'notes', label: 'Notes' },
                      ]}
                    />
                  </Disclosure>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Blackout dates</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Hard constraint. Nothing is scheduled on these dates at the given scope.
        </p>

        {blackouts.length === 0 ? (
          <div className="mt-4">
            <EmptyState>No blackouts.</EmptyState>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-ink-200 text-sm dark:divide-ink-700">
            {blackouts.map((blackout) => (
              <li key={blackout.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div>
                  <span className="font-medium">
                    {formatCalendarDate(blackout.startDate)}
                    {blackout.startDate.getTime() !== blackout.endDate.getTime() &&
                      ` → ${formatCalendarDate(blackout.endDate)}`}
                  </span>
                  <span className="ml-2 rounded-full bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-900">
                    {blackout.scope}
                    {blackout.division ? `: ${blackout.division.name}` : ''}
                    {blackout.team ? `: ${blackout.team.name}` : ''}
                    {blackout.venue ? `: ${blackout.venue.name}` : ''}
                  </span>
                  <div className="text-xs text-ink-500 dark:text-ink-400">{blackout.reason}</div>
                </div>
                {editable && <RemoveButton endpoint={`/api/orgs/${orgId}/blackouts/${blackout.id}`} />}
              </li>
            ))}
          </ul>
        )}

        {editable && (
          <div className="mt-4">
            <Disclosure summary="+ Add a blackout">
              <CreateForm
                endpoint={`/api/orgs/${orgId}/blackouts`}
                submitLabel="Add blackout"
                fields={[
                  {
                    name: 'scope',
                    label: 'Scope',
                    type: 'select',
                    required: true,
                    defaultValue: 'org',
                    options: [
                      { value: 'org', label: 'Whole organization' },
                      { value: 'division', label: 'One division' },
                      { value: 'team', label: 'One team' },
                      { value: 'venue', label: 'One venue' },
                    ],
                  },
                  {
                    name: 'divisionId',
                    label: 'Division (division scope)',
                    type: 'select',
                    options: divisions.map((d) => ({ value: d.id, label: d.name })),
                  },
                  {
                    name: 'teamId',
                    label: 'Team (team scope)',
                    type: 'select',
                    options: teams.map((t) => ({ value: t.id, label: t.name })),
                  },
                  {
                    name: 'venueId',
                    label: 'Venue (venue scope)',
                    type: 'select',
                    options: venues.map((v) => ({ value: v.id, label: v.name })),
                  },
                  { name: 'startDate', label: 'From', type: 'date', required: true },
                  { name: 'endDate', label: 'To', type: 'date', required: true },
                  { name: 'reason', label: 'Reason', required: true, placeholder: 'Field maintenance' },
                ]}
              />
            </Disclosure>
          </div>
        )}
      </Card>
    </>
  )
}
