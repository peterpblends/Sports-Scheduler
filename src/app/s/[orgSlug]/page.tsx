import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { readSchedule } from '@/lib/schedule/read'
import { ScheduleList } from '@/components/schedule-views'
import { Card, EmptyState, EntityImage } from '@/components/ui'
import { formatCalendarDate } from '@/lib/time'
import { YardMark } from '@/components/logo'
import { ThemeToggle } from '@/components/theme-toggle'
import { computeSeasonStandings } from '@/lib/schedule/standings'

/**
 * The public schedule (acceptance scenario 6, logged-out half).
 *
 * No session, no cookie, no token. What makes this safe is that it reads through the
 * same `readSchedule` every other view uses, with `canReadDrafts: false` hard-coded —
 * so it is served from the frozen published snapshot and cannot see a live row even in
 * principle. Publishing is the only thing that puts anything here.
 *
 * A season with nothing published 404s rather than rendering an empty page: "this
 * league exists and plays nothing" is itself information the office has not chosen to
 * release.
 */

export const dynamic = 'force-dynamic'

async function loadOrg(orgSlug: string) {
  return prisma.organization.findFirst({
    where: { slug: orgSlug, deletedAt: null },
    select: { id: true, name: true, slug: true, timezone: true },
  })
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}): Promise<Metadata> {
  const { orgSlug } = await params
  const org = await loadOrg(orgSlug)
  return {
    title: org ? `${org.name} — schedule` : 'Schedule',
    description: org ? `Published game schedule for ${org.name}.` : undefined,
    // A published schedule is public, but it is not something to rank in search.
    robots: { index: false, follow: false },
  }
}

export default async function PublicSchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ seasonId?: string; teamId?: string; divisionId?: string }>
}) {
  const { orgSlug } = await params
  const query = await searchParams

  const org = await loadOrg(orgSlug)
  if (!org) notFound()

  // Only seasons that have actually been published are listed.
  const seasons = await prisma.season.findMany({
    where: {
      deletedAt: null,
      league: { orgId: org.id, deletedAt: null },
      publishedVersionId: { not: null },
    },
    orderBy: [{ startDate: 'desc' }],
    include: {
      league: { select: { name: true, sport: true } },
      publishedVersion: { select: { number: true, publishedAt: true } },
    },
  })
  if (seasons.length === 0) notFound()

  const season = query.seasonId
    ? seasons.find((candidate) => candidate.id === query.seasonId)
    : seasons[0]
  if (!season) notFound()

  const [divisions, schedule, standings, teamLogos] = await Promise.all([
    prisma.division.findMany({
      where: { seasonId: season.id, deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        teams: { where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } },
      },
    }),
    readSchedule({
      orgId: org.id,
      seasonId: season.id,
      // Never negotiable on this page: the public sees the published snapshot only.
      canReadDrafts: false,
      filter: { teamId: query.teamId ?? null, divisionId: query.divisionId ?? null },
    }),
    // Same rule as the schedule above: computed off the published snapshot only.
    computeSeasonStandings({ orgId: org.id, seasonId: season.id, canReadDrafts: false }),
    prisma.team.findMany({
      where: { deletedAt: null, division: { seasonId: season.id, deletedAt: null } },
      select: { id: true, logoUrl: true },
    }),
  ])
  const logoByTeam = new Map(teamLogos.map((t) => [t.id, t.logoUrl]))

  const selectedTeam = divisions
    .flatMap((division) => division.teams)
    .find((team) => team.id === query.teamId)

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <YardMark size={28} />
        <ThemeToggle />
      </div>
      <header className="border-b border-ink-200 pb-6 dark:border-ink-700">
        <p className="text-xs font-medium tracking-widest text-turf-600 uppercase">
          {season.league.sport} · published schedule
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{org.name}</h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          {season.league.name} · {season.name} · {formatCalendarDate(season.startDate)} →{' '}
          {formatCalendarDate(season.endDate)}
        </p>
        {selectedTeam && (
          <p className="mt-2 text-sm font-medium">Showing {selectedTeam.name} only.</p>
        )}
      </header>

      <Card className="my-6">
        <form className="flex flex-wrap items-end gap-3" action={`/s/${orgSlug}`}>
          {seasons.length > 1 && (
            <PublicSelect name="seasonId" label="Season" value={season.id}>
              {seasons.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.league.name} · {candidate.name}
                </option>
              ))}
            </PublicSelect>
          )}
          <PublicSelect name="divisionId" label="Division" value={query.divisionId ?? ''} anyLabel="All divisions">
            {divisions.map((division) => (
              <option key={division.id} value={division.id}>
                {division.name}
              </option>
            ))}
          </PublicSelect>
          <PublicSelect name="teamId" label="Team" value={query.teamId ?? ''} anyLabel="All teams">
            {divisions.flatMap((division) =>
              division.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {division.name} · {team.name}
                </option>
              )),
            )}
          </PublicSelect>
          <button
            type="submit"
            className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium dark:border-ink-600 dark:bg-ink-800"
          >
            Show
          </button>
        </form>
      </Card>

      {schedule.rows.length === 0 ? (
        <EmptyState>
          {schedule.totalBeforeFilter === 0
            ? 'No games in the published schedule yet.'
            : 'No games match that filter.'}
        </EmptyState>
      ) : (
        // Officials are hidden: the public needs to know when and where a game is, not
        // who is refereeing it.
        <ScheduleList rows={schedule.rows} orgSlug={orgSlug} linkGames={false} showOfficials={false} />
      )}

      {standings.some((division) => division.standings.some((row) => row.played > 0)) && (
        <div className="mt-8 space-y-4">
          <h2 className="text-lg font-semibold">Standings</h2>
          {standings
            .filter((division) => division.standings.some((row) => row.played > 0))
            .map((division) => (
              <Card key={division.divisionId}>
                <h3 className="text-base font-semibold">{division.divisionName}</h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                      <tr>
                        <th className="pb-2 pr-2 font-medium">#</th>
                        <th className="pb-2 pr-4 font-medium">Team</th>
                        <th className="px-2 pb-2 text-right font-medium">GP</th>
                        <th className="px-2 pb-2 text-right font-medium">W</th>
                        <th className="px-2 pb-2 text-right font-medium">D</th>
                        <th className="px-2 pb-2 text-right font-medium">L</th>
                        <th className="px-2 pb-2 text-right font-medium">GD</th>
                        <th className="pb-2 pl-2 text-right font-medium">Pts</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                      {division.standings.map((row, index) => (
                        <tr key={row.teamId}>
                          <td className="py-2 pr-2 tabular-nums text-ink-500 dark:text-ink-400">
                            {index + 1}
                          </td>
                          <td className="py-2 pr-4">
                            <span className="flex items-center gap-2 font-medium">
                              <EntityImage
                                src={logoByTeam.get(row.teamId)}
                                name={row.teamName}
                                size={20}
                                shape="square"
                              />
                              {row.teamName}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{row.played}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{row.won}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{row.drawn}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{row.lost}</td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                          </td>
                          <td className="py-2 pl-2 text-right font-semibold tabular-nums">
                            {row.points}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
        </div>
      )}

      <footer className="mt-10 border-t border-ink-200 pt-6 text-sm text-ink-500 dark:border-ink-700 dark:text-ink-300">
        <p>
          {schedule.rows.length} of {schedule.totalBeforeFilter} game
          {schedule.totalBeforeFilter === 1 ? '' : 's'} · version {schedule.version?.number}
          {schedule.version?.publishedAt &&
            `, published ${new Date(schedule.version.publishedAt).toLocaleDateString()}`}
          . Times are shown in each venue&apos;s local zone.
        </p>
        <p className="mt-2">
          Run this league?{' '}
          <Link href="/login" className="text-turf-600 hover:underline">
            Sign in
          </Link>
          .
        </p>
      </footer>
    </main>
  )
}

function PublicSelect({
  name,
  label,
  value,
  anyLabel,
  children,
}: {
  name: string
  label: string
  value: string
  anyLabel?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={value}
        className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
      >
        {anyLabel && <option value="">{anyLabel}</option>}
        {children}
      </select>
    </div>
  )
}
