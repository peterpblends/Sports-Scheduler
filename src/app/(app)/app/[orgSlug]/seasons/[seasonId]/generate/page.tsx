import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, PageHeader } from '@/components/ui'
import { GenerateSchedule } from '@/components/generate-schedule'
import { formatCalendarDate } from '@/lib/time'

export default async function GeneratePage({
  params,
}: {
  params: Promise<{ orgSlug: string; seasonId: string }>
}) {
  const { orgSlug, seasonId } = await params
  const { role, orgId } = await requireOrgAccess(orgSlug, 'schedule:read:published')

  const season = await prisma.season.findFirst({
    where: { id: seasonId, deletedAt: null, league: { orgId, deletedAt: null } },
    include: {
      league: true,
      divisions: {
        where: { deletedAt: null },
        include: { _count: { select: { teams: { where: { deletedAt: null } } } } },
      },
      _count: { select: { games: { where: { deletedAt: null } } } },
    },
  })
  if (!season) notFound()

  const [fieldCount, refereeCount, playedCount] = await Promise.all([
    prisma.field.count({ where: { deletedAt: null, venue: { orgId, deletedAt: null } } }),
    prisma.referee.count({ where: { deletedAt: null, person: { orgId, deletedAt: null } } }),
    prisma.game.count({ where: { seasonId, deletedAt: null, status: 'played' } }),
  ])

  const teamCount = season.divisions.reduce((sum, division) => sum + division._count.teams, 0)
  const ready = teamCount >= 2 && fieldCount > 0

  return (
    <>
      <PageHeader
        title="Generate schedule"
        subtitle={`${season.league.name} · ${season.name} · ${formatCalendarDate(season.startDate)} → ${formatCalendarDate(season.endDate)}`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link
          href={`/app/${orgSlug}/seasons/${seasonId}`}
          className="text-ink-500 hover:underline dark:text-ink-300"
        >
          ← {season.name}
        </Link>
        <Link
          href={`/app/${orgSlug}/seasons/${seasonId}/versions`}
          className="font-medium text-turf-600 hover:underline"
        >
          Version history →
        </Link>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        {[
          { label: 'Divisions', value: season.divisions.length },
          { label: 'Teams', value: teamCount },
          { label: 'Fields available', value: fieldCount },
          { label: 'Officials', value: refereeCount },
        ].map((stat) => (
          <Card key={stat.label}>
            <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
              {stat.label}
            </div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{stat.value}</div>
          </Card>
        ))}
      </div>

      {!ready && (
        <div className="mb-6">
          <Alert>
            {teamCount < 2
              ? 'Add at least two teams to a division before generating.'
              : 'Add at least one field with availability before generating.'}
          </Alert>
        </div>
      )}

      {season._count.games > 0 && (
        <div className="mb-6">
          <Alert kind="info">
            This season already has {season._count.games} game
            {season._count.games === 1 ? '' : 's'}
            {playedCount > 0 && (
              <>
                , {playedCount} of them played. Played games are preserved by default — a
                regeneration leaves them exactly where they are and schedules around them
              </>
            )}
            . Committing retires the rest into history rather than deleting them.
          </Alert>
        </div>
      )}

      {ready && (
        <GenerateSchedule
          orgId={orgId}
          seasonId={seasonId}
          seasonName={`${season.league.name} · ${season.name}`}
          canGenerate={can(role, 'schedule:generate')}
        />
      )}
    </>
  )
}
