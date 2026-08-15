import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Card, EmptyState, EntityImage, PageHeader } from '@/components/ui'
import { computeSeasonStandings } from '@/lib/schedule/standings'

/**
 * League tables — one per division, points/goal-difference/goals-for sorted, the
 * usual soccer scoring. Read-only: standings are a derived view of played games'
 * scores, nothing here is itself editable.
 */
export default async function StandingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ seasonId?: string }>
}) {
  const { orgSlug } = await params
  const query = await searchParams
  const { role, orgId } = await requireOrgAccess(orgSlug, 'schedule:read:published')
  const canReadDrafts = can(role, 'schedule:read')

  const seasons = await prisma.season.findMany({
    where: { deletedAt: null, league: { orgId, deletedAt: null } },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    include: { league: { select: { name: true } } },
  })

  const activeSeason = query.seasonId
    ? seasons.find((season) => season.id === query.seasonId)
    : (seasons.find((season) => season.status === 'active') ?? seasons[0])

  if (seasons.length === 0 || !activeSeason) {
    return (
      <>
        <PageHeader title="Standings" subtitle="No seasons yet." />
        <EmptyState>Standings appear once a season has divisions and played games.</EmptyState>
      </>
    )
  }

  const [divisions, teams] = await Promise.all([
    computeSeasonStandings({ orgId, seasonId: activeSeason.id, canReadDrafts }),
    prisma.team.findMany({
      where: { deletedAt: null, division: { seasonId: activeSeason.id, deletedAt: null } },
      select: { id: true, logoUrl: true },
    }),
  ])
  const logoByTeam = new Map(teams.map((t) => [t.id, t.logoUrl]))

  const totalGames = divisions.reduce(
    (sum, division) => sum + division.standings.reduce((s, row) => s + row.played, 0) / 2,
    0,
  )

  return (
    <>
      <PageHeader
        title="Standings"
        subtitle={`${activeSeason.league.name} · ${activeSeason.name}`}
      />

      {seasons.length > 1 && (
        <Card className="mb-6">
          <form className="flex flex-wrap items-end gap-3" action={`/app/${orgSlug}/standings`}>
            <div className="min-w-56">
              <label htmlFor="seasonId" className="mb-1.5 block text-sm font-medium">
                Season
              </label>
              <select
                id="seasonId"
                name="seasonId"
                defaultValue={activeSeason.id}
                className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-600 dark:bg-ink-900"
              >
                {seasons.map((season) => (
                  <option key={season.id} value={season.id}>
                    {season.league.name} · {season.name}
                    {season.status === 'active' ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium dark:border-ink-600 dark:bg-ink-800"
            >
              Show
            </button>
          </form>
        </Card>
      )}

      {divisions.length === 0 || totalGames === 0 ? (
        <EmptyState>
          {divisions.length === 0
            ? 'No divisions in this season yet.'
            : 'No games have been played yet — a standing only counts a game once it has a final score.'}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {divisions.map((division) => (
            <Card key={division.divisionId}>
              <h2 className="text-base font-semibold">{division.divisionName}</h2>
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
                      <th className="px-2 pb-2 text-right font-medium">GF</th>
                      <th className="px-2 pb-2 text-right font-medium">GA</th>
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
                          <Link
                            href={`/app/${orgSlug}/teams/${row.teamId}`}
                            className="flex items-center gap-2 font-medium text-turf-600 hover:underline"
                          >
                            <EntityImage src={logoByTeam.get(row.teamId)} name={row.teamName} size={22} shape="square" />
                            {row.teamName}
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.played}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.won}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.drawn}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.lost}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.goalsFor}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.goalsAgainst}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                        </td>
                        <td className="py-2 pl-2 text-right font-semibold tabular-nums">{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}

          <p className="text-xs text-ink-500 dark:text-ink-400">
            3 points a win, 1 a draw. Ties break on goal difference, then goals scored, then name.
            {canReadDrafts && ' Includes games not yet published.'}
          </p>
        </div>
      )}
    </>
  )
}
