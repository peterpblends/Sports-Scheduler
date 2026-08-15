import Link from 'next/link'
import clsx from 'clsx'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, PageHeader } from '@/components/ui'
import { CreateForm, TimeSlotForm } from '@/components/crud-forms'

/**
 * The setup wizard: get a new organization from empty to schedulable.
 *
 * Ordered by real dependency rather than by menu structure — a division needs a
 * season, a season needs a league, a slot needs a field — and every step reports its
 * live state, so the page is equally useful as a checklist for an org that is halfway
 * through. Each step's form is the same endpoint the dedicated page uses; this is a
 * shortcut through the setup, not a second way to write it.
 */

type StepState = {
  key: string
  title: string
  why: string
  done: boolean
  detail: string
  href: string
  hrefLabel: string
}

export default async function SetupPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const { role, orgId, orgName } = await requireOrgAccess(orgSlug, 'structure:read')
  const canWriteStructure = can(role, 'structure:write')
  const canWriteVenues = can(role, 'venue:write')
  const canWriteRoster = can(role, 'roster:write')

  const [org, leagues, seasons, divisions, teams, venues, fields, slots, referees, published] =
    await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
      prisma.league.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.season.findMany({
        where: { deletedAt: null, league: { orgId, deletedAt: null } },
        orderBy: { startDate: 'desc' },
        include: { league: { select: { name: true } } },
      }),
      prisma.division.findMany({
        where: { deletedAt: null, season: { league: { orgId, deletedAt: null } } },
        orderBy: { name: 'asc' },
        include: { season: { select: { id: true, name: true } } },
      }),
      prisma.team.count({
        where: { deletedAt: null, division: { season: { league: { orgId, deletedAt: null } } } },
      }),
      prisma.venue.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, timezone: true },
      }),
      prisma.field.findMany({
        where: { deletedAt: null, venue: { orgId, deletedAt: null } },
        orderBy: { name: 'asc' },
        include: { venue: { select: { name: true, timezone: true } } },
      }),
      prisma.timeSlot.count({
        where: { deletedAt: null, field: { deletedAt: null, venue: { orgId, deletedAt: null } } },
      }),
      prisma.referee.count({ where: { deletedAt: null, person: { orgId, deletedAt: null } } }),
      prisma.season.count({
        where: {
          deletedAt: null,
          league: { orgId, deletedAt: null },
          publishedVersionId: { not: null },
        },
      }),
    ])

  const games = await prisma.game.count({
    where: { deletedAt: null, season: { league: { orgId, deletedAt: null } } },
  })

  const plural = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`

  const steps: StepState[] = [
    {
      key: 'league',
      title: 'Create a league',
      why: 'A league holds seasons. Most organizations have one per competition level.',
      done: leagues.length > 0,
      detail: leagues.length ? leagues.map((league) => league.name).join(', ') : 'None yet',
      href: `/app/${orgSlug}/leagues`,
      hrefLabel: 'Leagues',
    },
    {
      key: 'season',
      title: 'Add a season',
      why: 'A season sets the date range everything is scheduled inside.',
      done: seasons.length > 0,
      detail: seasons.length
        ? seasons.map((season) => `${season.league.name} · ${season.name}`).join(', ')
        : 'None yet',
      href: `/app/${orgSlug}/leagues`,
      hrefLabel: 'Leagues',
    },
    {
      key: 'division',
      title: 'Add divisions',
      why: 'Teams play within a division, so this is what the round robin is built over.',
      done: divisions.length > 0,
      detail: divisions.length ? plural(divisions.length, 'division') : 'None yet',
      href: seasons[0] ? `/app/${orgSlug}/seasons/${seasons[0].id}` : `/app/${orgSlug}/leagues`,
      hrefLabel: 'Season',
    },
    {
      key: 'teams',
      title: 'Add at least two teams',
      why: 'An odd count is fine — each round gets a bye, which the engine handles.',
      done: teams >= 2,
      detail: plural(teams, 'team'),
      href: seasons[0] ? `/app/${orgSlug}/seasons/${seasons[0].id}` : `/app/${orgSlug}/leagues`,
      hrefLabel: 'Season',
    },
    {
      key: 'venue',
      title: 'Add a venue',
      why: 'A venue carries the time zone every kickoff at it is displayed in.',
      done: venues.length > 0,
      detail: venues.length
        ? venues.map((venue) => `${venue.name} (${venue.timezone})`).join(', ')
        : 'None yet',
      href: `/app/${orgSlug}/venues`,
      hrefLabel: 'Venues',
    },
    {
      key: 'field',
      title: 'Add fields',
      why: 'Fields are what get booked. Two fields at one venue double the capacity.',
      done: fields.length > 0,
      detail: fields.length ? plural(fields.length, 'field') : 'None yet',
      href: `/app/${orgSlug}/venues`,
      hrefLabel: 'Venues',
    },
    {
      key: 'slots',
      title: 'Declare field availability',
      why: 'Without a window the engine has nowhere to put a game. Stored as local wall-clock, so 8am stays 8am across a DST change.',
      done: slots > 0,
      detail: slots ? plural(slots, 'time slot') : 'None yet',
      href: `/app/${orgSlug}/venues`,
      hrefLabel: 'Venues',
    },
    {
      key: 'officials',
      title: 'Add officials',
      why: 'Optional, but a schedule generated without them leaves every game unstaffed.',
      done: referees > 0,
      detail: referees ? plural(referees, 'official') : 'None yet',
      href: `/app/${orgSlug}/people`,
      hrefLabel: 'People',
    },
    {
      key: 'generate',
      title: 'Generate a schedule',
      why: 'Dry-run first: it reports what it could not place and which constraint blocked it.',
      done: games > 0,
      detail: games ? plural(games, 'game') : 'None yet',
      href: seasons[0]
        ? `/app/${orgSlug}/seasons/${seasons[0].id}/generate`
        : `/app/${orgSlug}/leagues`,
      hrefLabel: 'Generate',
    },
    {
      key: 'publish',
      title: 'Publish it',
      why: 'Until a version is published, coaches, referees and the public see nothing.',
      done: published > 0,
      detail: published ? plural(published, 'season published') : 'Nothing published',
      href: seasons[0]
        ? `/app/${orgSlug}/seasons/${seasons[0].id}/versions`
        : `/app/${orgSlug}/leagues`,
      hrefLabel: 'Versions',
    },
  ]

  const doneCount = steps.filter((step) => step.done).length
  const next = steps.find((step) => !step.done)

  return (
    <>
      <PageHeader
        title="Setup"
        subtitle={`${orgName} · ${doneCount} of ${steps.length} steps done`}
      />

      <div className="mb-6">
        {next ? (
          <Alert kind="info">
            Next: <strong>{next.title}</strong>. {next.why}
          </Alert>
        ) : (
          <Alert kind="success">
            Everything is in place — schedule generated and published. The{' '}
            <Link href={`/app/${orgSlug}/schedule`} className="underline">
              schedule
            </Link>{' '}
            is live.
          </Alert>
        )}
      </div>

      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step.key}>
            <Card className={clsx(step.done && 'opacity-70')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex gap-3">
                  <span
                    aria-hidden
                    className={clsx(
                      'mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-semibold',
                      step.done
                        ? 'bg-gold text-ink-900'
                        : 'border border-ink-300 text-ink-500 dark:border-ink-600 dark:text-ink-400',
                    )}
                  >
                    {step.done ? '✓' : index + 1}
                  </span>
                  <div>
                    <h2 className="text-base font-semibold">
                      {step.title}
                      <span className="sr-only">{step.done ? ' — done' : ' — not done'}</span>
                    </h2>
                    <p className="mt-1 max-w-prose text-sm text-ink-500 dark:text-ink-300">
                      {step.why}
                    </p>
                    <p className="mt-1 text-xs text-ink-600 dark:text-ink-400">{step.detail}</p>
                  </div>
                </div>
                <Link
                  href={step.href}
                  className="whitespace-nowrap text-sm font-medium text-turf-600 hover:underline"
                >
                  {step.hrefLabel} →
                </Link>
              </div>

              {/* The first unfinished step gets its form inline, so the common path
                  through setup does not require navigating away and back. */}
              {!step.done && next?.key === step.key && (
                <div className="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
                  <InlineStep
                    step={step.key}
                    orgId={orgId}
                    orgTimezone={org.timezone}
                    canWriteStructure={canWriteStructure}
                    canWriteVenues={canWriteVenues}
                    canWriteRoster={canWriteRoster}
                    leagues={leagues}
                    seasons={seasons.map((season) => ({
                      id: season.id,
                      label: `${season.league.name} · ${season.name}`,
                    }))}
                    divisions={divisions.map((division) => ({
                      id: division.id,
                      label: `${division.season.name} · ${division.name}`,
                    }))}
                    venues={venues}
                    fields={fields.map((field) => ({
                      id: field.id,
                      label: `${field.venue.name} — ${field.name}`,
                      timezone: field.venue.timezone,
                    }))}
                  />
                </div>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </>
  )
}

function InlineStep({
  step,
  orgId,
  orgTimezone,
  canWriteStructure,
  canWriteVenues,
  canWriteRoster,
  leagues,
  seasons,
  divisions,
  venues,
  fields,
}: {
  step: string
  orgId: string
  orgTimezone: string
  canWriteStructure: boolean
  canWriteVenues: boolean
  canWriteRoster: boolean
  leagues: Array<{ id: string; name: string }>
  seasons: Array<{ id: string; label: string }>
  divisions: Array<{ id: string; label: string }>
  venues: Array<{ id: string; name: string }>
  fields: Array<{ id: string; label: string; timezone: string }>
}) {
  const denied = (
    <p className="text-sm text-ink-500 dark:text-ink-300">
      Your role cannot make this change. Ask an admin.
    </p>
  )

  switch (step) {
    case 'league':
      if (!canWriteStructure) return denied
      return (
        <CreateForm
          endpoint={`/api/orgs/${orgId}/leagues`}
          submitLabel="Create league"
          fields={[
            { name: 'name', label: 'Name', required: true, placeholder: 'Recreational' },
            { name: 'sport', label: 'Sport', required: true, defaultValue: 'soccer' },
          ]}
        />
      )

    case 'season':
      if (!canWriteStructure) return denied
      return (
        <CreateForm
          endpoint={`/api/orgs/${orgId}/seasons`}
          submitLabel="Create season"
          fields={[
            {
              name: 'leagueId',
              label: 'League',
              type: 'select',
              required: true,
              options: leagues.map((league) => ({ value: league.id, label: league.name })),
            },
            { name: 'name', label: 'Name', required: true, placeholder: 'Spring 2026' },
            { name: 'startDate', label: 'Starts', type: 'date', required: true },
            { name: 'endDate', label: 'Ends', type: 'date', required: true },
          ]}
        />
      )

    case 'division':
      if (!canWriteStructure) return denied
      return (
        <CreateForm
          endpoint={`/api/orgs/${orgId}/divisions`}
          submitLabel="Create division"
          fields={[
            {
              name: 'seasonId',
              label: 'Season',
              type: 'select',
              required: true,
              options: seasons.map((season) => ({ value: season.id, label: season.label })),
            },
            { name: 'name', label: 'Name', required: true, placeholder: 'U12 Boys' },
          ]}
        />
      )

    case 'teams':
      if (!canWriteRoster) return denied
      return (
        <CreateForm
          endpoint={`/api/orgs/${orgId}/teams`}
          submitLabel="Create team"
          fields={[
            {
              name: 'divisionId',
              label: 'Division',
              type: 'select',
              required: true,
              options: divisions.map((division) => ({ value: division.id, label: division.label })),
            },
            { name: 'name', label: 'Name', required: true, placeholder: 'Riverside Rovers' },
            { name: 'primaryColor', label: 'Colour', type: 'color', defaultValue: '#1b7f3a' },
          ]}
        />
      )

    case 'venue':
      if (!canWriteVenues) return denied
      return (
        <CreateForm
          endpoint={`/api/orgs/${orgId}/venues`}
          submitLabel="Create venue"
          fields={[
            { name: 'name', label: 'Name', required: true, placeholder: 'Riverside Park' },
            {
              name: 'timezone',
              label: 'Time zone',
              required: true,
              defaultValue: orgTimezone,
              help: 'An IANA zone. Every kickoff here is displayed in it.',
            },
            { name: 'address', label: 'Address' },
          ]}
        />
      )

    // A field belongs to a venue and a slot belongs to a field, and both endpoints
    // carry the parent in the path — so these steps render one form per parent rather
    // than a select. With a single venue, which is the common case, that reads as one
    // form anyway.
    case 'field':
      if (!canWriteVenues) return denied
      return (
        <div className="space-y-4">
          {venues.map((venue) => (
            <div key={venue.id}>
              <h3 className="mb-2 text-sm font-medium">{venue.name}</h3>
              <CreateForm
                endpoint={`/api/orgs/${orgId}/venues/${venue.id}/fields`}
                submitLabel="Add field"
                fields={[
                  { name: 'name', label: 'Name', required: true, placeholder: 'Field 1' },
                  { name: 'notes', label: 'Notes' },
                ]}
              />
            </div>
          ))}
        </div>
      )

    case 'slots':
      if (!canWriteVenues) return denied
      return (
        <div className="space-y-4">
          <p className="text-sm text-ink-500 dark:text-ink-300">
            A weekly window in the venue&apos;s own local time — 8am stays 8am when the clocks
            change.
          </p>
          {fields.map((field) => (
            <div key={field.id}>
              <h3 className="text-sm font-medium">{field.label}</h3>
              <TimeSlotForm orgId={orgId} fieldId={field.id} timezone={field.timezone} />
            </div>
          ))}
        </div>
      )

    case 'officials':
      if (!canWriteRoster) return denied
      return (
        <>
          <p className="mb-3 text-sm text-ink-500 dark:text-ink-300">
            Create the person first; the People page turns them into an official and holds
            certification, pay and availability.
          </p>
          <CreateForm
            endpoint={`/api/orgs/${orgId}/people`}
            submitLabel="Create person"
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'email', label: 'Email', type: 'email' },
              { name: 'phone', label: 'Phone' },
            ]}
          />
        </>
      )

    default:
      return (
        <p className="text-sm text-ink-500 dark:text-ink-300">
          Use the link above — this step has its own page.
        </p>
      )
  }
}
