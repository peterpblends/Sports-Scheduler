import type { ExistingGameInput, PlayoffFormat, TeamInput } from './types'

/**
 * Playoff bracket generation.
 *
 * A bracket is a pure function of a seed list, so it can be generated before any
 * results exist (from a provisional order) and regenerated later from real
 * standings without changing anything else in the schedule.
 */

export type BracketMatch = {
  /** 1 = first round. */
  round: number
  matchIndex: number
  /** Null while the slot is still waiting on an earlier match. */
  homeTeamId: string | null
  awayTeamId: string | null
  label: string
}

export type Standing = {
  teamId: string
  teamName: string
  played: number
  won: number
  drawn: number
  lost: number
  goalsFor: number
  goalsAgainst: number
  goalDifference: number
  points: number
}

/**
 * Standings from played games only. 3 points a win, 1 a draw — the usual soccer
 * table. Ties break on goal difference, then goals scored, then name, so the order
 * is total and reproducible.
 */
export function computeStandings(teams: TeamInput[], games: ExistingGameInput[]): Standing[] {
  const table = new Map<string, Standing>(
    teams.map((team) => [
      team.id,
      {
        teamId: team.id,
        teamName: team.name,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
      },
    ]),
  )

  for (const game of games) {
    if (game.status !== 'played') continue
    if (game.homeScore == null || game.awayScore == null) continue

    const home = table.get(game.homeTeamId)
    const away = table.get(game.awayTeamId)
    if (!home || !away) continue

    home.played += 1
    away.played += 1
    home.goalsFor += game.homeScore
    home.goalsAgainst += game.awayScore
    away.goalsFor += game.awayScore
    away.goalsAgainst += game.homeScore

    if (game.homeScore > game.awayScore) {
      home.won += 1
      home.points += 3
      away.lost += 1
    } else if (game.homeScore < game.awayScore) {
      away.won += 1
      away.points += 3
      home.lost += 1
    } else {
      home.drawn += 1
      away.drawn += 1
      home.points += 1
      away.points += 1
    }
  }

  const standings = [...table.values()]
  for (const row of standings) row.goalDifference = row.goalsFor - row.goalsAgainst

  standings.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalDifference - a.goalDifference ||
      b.goalsFor - a.goalsFor ||
      a.teamName.localeCompare(b.teamName),
  )
  return standings
}

/** Largest power of two at or below `n`, minimum 2. */
function bracketSize(n: number): number {
  let size = 2
  while (size * 2 <= n) size *= 2
  return size
}

/**
 * Standard seeding order for a bracket: 1 plays the lowest seed, 2 plays the
 * second-lowest, and the halves are arranged so the top two seeds can only meet in
 * the final. Built by recursively mirroring, which is how printed brackets are laid
 * out.
 */
function seedOrder(size: number): number[] {
  let order = [1, 2]
  while (order.length < size) {
    const next: number[] = []
    const total = order.length * 2 + 1
    for (const seed of order) {
      next.push(seed, total - seed)
    }
    order = next
  }
  return order
}

/**
 * Single elimination: round 1 pairs the seeds, later rounds are placeholders until
 * their feeder matches are decided.
 */
function singleElimination(seeds: string[], labelPrefix: string): BracketMatch[] {
  const size = bracketSize(seeds.length)
  const order = seedOrder(size)
  const matches: BracketMatch[] = []

  for (let i = 0; i < size / 2; i++) {
    const homeSeed = order[i * 2]!
    const awaySeed = order[i * 2 + 1]!
    matches.push({
      round: 1,
      matchIndex: i,
      homeTeamId: seeds[homeSeed - 1] ?? null,
      awayTeamId: seeds[awaySeed - 1] ?? null,
      label: `${labelPrefix} R1 M${i + 1} (seed ${homeSeed} v ${awaySeed})`,
    })
  }

  let remaining = size / 2
  let round = 2
  while (remaining > 1) {
    remaining = remaining / 2
    for (let i = 0; i < remaining; i++) {
      matches.push({
        round,
        matchIndex: i,
        homeTeamId: null,
        awayTeamId: null,
        label:
          remaining === 1
            ? `${labelPrefix} Final`
            : `${labelPrefix} R${round} M${i + 1}`,
      })
    }
    round += 1
  }

  return matches
}

/**
 * Double elimination: the winners bracket as above, plus a losers bracket and a
 * grand final. Losers-bracket participants are unknown at generation time, so those
 * matches are placeholders — their purpose here is to reserve the right number of
 * slots on the calendar.
 */
function doubleElimination(seeds: string[], labelPrefix: string): BracketMatch[] {
  const winners = singleElimination(seeds, `${labelPrefix} W`)
  const size = bracketSize(seeds.length)
  const matches = [...winners]

  // A double-elimination bracket of `size` entrants needs size - 2 losers matches,
  // then the grand final.
  const losersMatches = Math.max(0, size - 2)
  const lastWinnersRound = Math.max(...winners.map((m) => m.round))

  let round = lastWinnersRound + 1
  let placed = 0
  let width = Math.max(1, size / 4)

  while (placed < losersMatches) {
    for (let i = 0; i < width && placed < losersMatches; i++, placed++) {
      matches.push({
        round,
        matchIndex: i,
        homeTeamId: null,
        awayTeamId: null,
        label: `${labelPrefix} L R${round - lastWinnersRound} M${i + 1}`,
      })
    }
    round += 1
    width = Math.max(1, Math.floor(width / 2))
  }

  matches.push({
    round,
    matchIndex: 0,
    homeTeamId: null,
    awayTeamId: null,
    label: `${labelPrefix} Grand Final`,
  })

  return matches
}

export function buildBracket(
  seeds: string[],
  format: PlayoffFormat,
  labelPrefix: string,
): BracketMatch[] {
  if (seeds.length < 2) return []
  return format === 'double_elimination'
    ? doubleElimination(seeds, labelPrefix)
    : singleElimination(seeds, labelPrefix)
}
