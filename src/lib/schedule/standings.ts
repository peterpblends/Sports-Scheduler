import { prisma } from '../prisma'
import { readSchedule } from './read'
import { computeStandings, type Standing } from '../scheduler/playoffs'

/**
 * Per-division league tables for a season.
 *
 * Goes through the same `readSchedule` every other view uses, so the published/draft
 * split is the one decided there: a draft reader (`canReadDrafts`) gets standings off
 * the live working set, everyone else off the frozen published snapshot — the same
 * guarantee that stops an in-progress draft edit from leaking anywhere else in the
 * app. `computeStandings` itself only ever counts a game with `status: 'played'` and
 * both scores recorded; everything else is 0-0-0 on the table.
 *
 * Does not itself verify `seasonId` belongs to `orgId` — same discipline as
 * `readSchedule` — callers are expected to have already proven that (an API route via
 * `assertSeasonInOrg`, a page via its own already-org-scoped season lookup).
 */

export type DivisionStandings = {
  divisionId: string
  divisionName: string
  standings: Standing[]
}

export async function computeSeasonStandings(input: {
  orgId: string
  seasonId: string
  canReadDrafts: boolean
}): Promise<DivisionStandings[]> {
  const { orgId, seasonId, canReadDrafts } = input

  const [divisions, schedule] = await Promise.all([
    prisma.division.findMany({
      where: { seasonId, deletedAt: null, season: { league: { orgId, deletedAt: null } } },
      orderBy: { name: 'asc' },
      include: {
        teams: {
          where: { deletedAt: null },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, divisionId: true },
        },
      },
    }),
    readSchedule({ orgId, seasonId, canReadDrafts }),
  ])

  const rowsByDivision = new Map<string, typeof schedule.rows>()
  for (const row of schedule.rows) {
    const bucket = rowsByDivision.get(row.divisionId)
    if (bucket) bucket.push(row)
    else rowsByDivision.set(row.divisionId, [row])
  }

  return divisions.map((division) => ({
    divisionId: division.id,
    divisionName: division.name,
    standings: computeStandings(division.teams, rowsByDivision.get(division.id) ?? []),
  }))
}
