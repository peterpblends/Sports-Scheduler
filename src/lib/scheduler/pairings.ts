import { shuffled, type Rng } from './random'
import type { ByeRecord, DivisionInput, ScheduleConfig, TeamInput } from './types'

/**
 * A fixture the engine still has to find a slot for. `round` is the round the
 * round robin puts it in; placement treats that as a strong preference rather than
 * a hard rule, so a round can spill forward when capacity runs short.
 */
export type Pairing = {
  divisionId: string
  homeTeamId: string
  awayTeamId: string
  round: number
  /** True when the two teams are in different divisions. */
  crossDivision: boolean
}

export type PairingPlan = {
  pairings: Pairing[]
  byes: ByeRecord[]
  /** Rounds the round robin produced, before any cap. */
  rounds: number
  notes: string[]
}

const BYE = '__bye__'

/**
 * One pass of the circle method.
 *
 * Teams are laid out in two rows; one team is pinned and the rest rotate. That
 * gives every team exactly one opponent per round, each pair meeting once across
 * `n - 1` rounds. With an odd count a dummy is added, and whoever draws it that
 * round sits out — which is what distributes byes evenly for free.
 */
function circleMethod(teamIds: string[]): Array<Array<[string, string]>> {
  const ids = [...teamIds]
  if (ids.length % 2 === 1) ids.push(BYE)

  const n = ids.length
  const rounds: Array<Array<[string, string]>> = []
  let order = [...ids]

  for (let round = 0; round < n - 1; round++) {
    const games: Array<[string, string]> = []
    for (let i = 0; i < n / 2; i++) {
      // Pairs only. Which side hosts is decided later, by `orientFixture`, so that
      // home/away can be balanced across the whole pass rather than left to the
      // rotation's arbitrary column order.
      games.push([order[i]!, order[n - 1 - i]!])
    }
    rounds.push(games)

    // Rotate everything except the pinned first entry.
    const [pinned, ...rest] = order
    const last = rest.pop()!
    order = [pinned!, last, ...rest]
  }

  return rounds
}

/**
 * Splits the dummy-team fixtures out into bye records.
 *
 * Byes need no rebalancing: with an odd team count the circle method already gives
 * every team exactly one bye per pass, because exactly one team draws the dummy each
 * round and the rotation visits each team once. Reassigning a bye to a different
 * team would mean pulling that team out of a real fixture, which destroys the
 * round-robin property — so this only extracts, never rearranges.
 */
function extractByes(
  rounds: Array<Array<[string, string]>>,
  divisionId: string,
): { rounds: Array<Array<[string, string]>>; byes: ByeRecord[] } {
  const byes: ByeRecord[] = []
  const cleaned: Array<Array<[string, string]>> = []

  for (const [index, games] of rounds.entries()) {
    const real: Array<[string, string]> = []
    for (const [home, away] of games) {
      if (home === BYE) byes.push({ divisionId, teamId: away, roundNumber: index + 1 })
      else if (away === BYE) byes.push({ divisionId, teamId: home, roundNumber: index + 1 })
      else real.push([home, away])
    }
    cleaned.push(real)
  }

  return { rounds: cleaned, byes }
}

/** Rotates a list left by `by`, leaving contents otherwise untouched. */
function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return []
  const offset = ((by % items.length) + items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

/**
 * Builds the fixture list for one pool of teams.
 *
 * `roundRobinTimes` passes are concatenated; every even pass swaps home and away so
 * a double round robin gives each pair one game at each ground rather than two at
 * the same one.
 */
function poolPairings(
  teams: TeamInput[],
  config: ScheduleConfig,
  divisionIdFor: (teamId: string) => string,
  poolId: string,
  rng: Rng,
): { pairings: Pairing[]; byes: ByeRecord[]; rounds: number } {
  if (teams.length < 2) return { pairings: [], byes: [], rounds: 0 }

  // Shuffled once, deterministically, so the rotation is not just alphabetical —
  // otherwise the same teams always open against each other.
  const ids = shuffled(
    teams.map((t) => t.id).sort((a, b) => a.localeCompare(b)),
    rng,
  )

  const pairings: Pairing[] = []
  const byes: ByeRecord[] = []
  let roundOffset = 0

  /**
   * Home/away is decided once per pair and then mirrored on alternate passes.
   *
   * Two properties fall out of that. A pair meets once at each ground across any two
   * passes, which is what a double round robin means. And because the first pass
   * orients each fixture toward whichever team is currently most away-heavy, a season
   * truncated part-way through still comes out near-balanced rather than skewed.
   */
  const orientation = new Map<string, [string, string]>()
  const homeCount = new Map<string, number>()
  const awayCount = new Map<string, number>()

  const imbalance = (teamId: string) =>
    (homeCount.get(teamId) ?? 0) - (awayCount.get(teamId) ?? 0)

  const orientFixture = (x: string, y: string): [string, string] => {
    const key = x < y ? `${x}|${y}` : `${y}|${x}`
    const cached = orientation.get(key)
    if (cached) return cached
    // The team with fewer home games so far hosts; ids break the tie.
    const chosen: [string, string] =
      imbalance(x) < imbalance(y) || (imbalance(x) === imbalance(y) && x < y) ? [x, y] : [y, x]
    orientation.set(key, chosen)
    return chosen
  }

  for (let pass = 0; pass < config.roundRobinTimes; pass++) {
    // `balanced` shifts the seeding on later passes so that a team whose bye fell
    // early in pass 1 gets a late one in pass 2. That matters when the season is
    // truncated below a full round robin, since the surviving rounds then spread
    // byes more evenly. `rotate` keeps every pass on the same rotation.
    const passIds =
      config.byeHandling === 'balanced' && pass > 0
        ? rotate(ids, Math.floor(ids.length / 2) * pass)
        : ids

    const raw = circleMethod(passIds)
    const { rounds: cleaned, byes: passByes } = extractByes(raw, poolId)

    for (const [index, games] of cleaned.entries()) {
      const round = roundOffset + index + 1
      for (const [x, y] of games) {
        const [first, second] = orientFixture(x, y)
        // Odd passes swap grounds, so each pair hosts once and visits once.
        const [h, a] = pass % 2 === 1 ? [second, first] : [first, second]

        homeCount.set(h, (homeCount.get(h) ?? 0) + 1)
        awayCount.set(a, (awayCount.get(a) ?? 0) + 1)

        pairings.push({
          divisionId: divisionIdFor(h),
          homeTeamId: h,
          awayTeamId: a,
          round,
          crossDivision: divisionIdFor(h) !== divisionIdFor(a),
        })
      }
    }
    for (const bye of passByes) byes.push({ ...bye, roundNumber: roundOffset + bye.roundNumber })

    roundOffset += cleaned.length
  }

  return { pairings, byes, rounds: roundOffset }
}

/**
 * The full fixture plan across every division, honouring the cross-division mode
 * and the caps on rounds and games per team.
 */
export function buildPairings(
  divisions: DivisionInput[],
  config: ScheduleConfig,
  rng: Rng,
): PairingPlan {
  const notes: string[] = []
  const allTeams = divisions.flatMap((d) => d.teams)
  const divisionOf = new Map(allTeams.map((t) => [t.id, t.divisionId]))
  const divisionIdFor = (teamId: string) => divisionOf.get(teamId) ?? ''

  let pairings: Pairing[] = []
  let byes: ByeRecord[] = []
  let rounds = 0

  if (config.crossDivisionPlay === 'full') {
    // One pool: every team can meet every other, division boundaries ignored.
    const pool = poolPairings(allTeams, config, divisionIdFor, 'all', rng.fork('pool:all'))
    pairings = pool.pairings
    byes = pool.byes
    rounds = pool.rounds
    notes.push('Cross-division play is full: all teams were pooled into one round robin.')
  } else {
    for (const division of [...divisions].sort((a, b) => a.id.localeCompare(b.id))) {
      const pool = poolPairings(
        division.teams,
        config,
        divisionIdFor,
        division.id,
        rng.fork(`pool:${division.id}`),
      )
      pairings.push(...pool.pairings)
      byes.push(...pool.byes)
      rounds = Math.max(rounds, pool.rounds)
    }

    if (config.crossDivisionPlay === 'limited' && divisions.length > 1) {
      const extra = limitedCrossDivision(divisions, config, rounds, rng.fork('cross'))
      pairings.push(...extra.pairings)
      rounds = Math.max(rounds, extra.rounds)
      notes.push(
        `Cross-division play is limited: added ${extra.pairings.length} inter-division games ` +
          `(${config.crossDivisionGamesPerTeam} per team target).`,
      )
    }
  }

  // --- round cap
  if (config.numberOfRounds !== null && rounds > config.numberOfRounds) {
    const kept = config.numberOfRounds
    const dropped = pairings.length
    pairings = pairings.filter((p) => p.round <= kept)
    byes = byes.filter((b) => b.roundNumber <= kept)
    notes.push(
      `Round robin wanted ${rounds} rounds; config caps it at ${kept}, ` +
        `so ${dropped - pairings.length} fixtures were dropped.`,
    )
    rounds = kept
  }

  // --- games-per-team cap, applied by dropping the latest fixtures first
  if (config.gamesPerTeamCap !== null) {
    const counts = new Map<string, number>()
    const kept: Pairing[] = []
    // Ascending round order means early fixtures survive and late ones are trimmed.
    for (const pairing of [...pairings].sort(
      (a, b) => a.round - b.round || a.homeTeamId.localeCompare(b.homeTeamId),
    )) {
      const home = counts.get(pairing.homeTeamId) ?? 0
      const away = counts.get(pairing.awayTeamId) ?? 0
      if (home >= config.gamesPerTeamCap || away >= config.gamesPerTeamCap) continue
      counts.set(pairing.homeTeamId, home + 1)
      counts.set(pairing.awayTeamId, away + 1)
      kept.push(pairing)
    }
    if (kept.length !== pairings.length) {
      notes.push(
        `Games-per-team cap of ${config.gamesPerTeamCap} trimmed ` +
          `${pairings.length - kept.length} fixtures.`,
      )
    }
    pairings = kept
    byes = byes.filter((b) => b.roundNumber <= rounds)
  }

  // Sorted so downstream placement order is fully determined by the data.
  pairings.sort(
    (a, b) =>
      a.round - b.round ||
      a.divisionId.localeCompare(b.divisionId) ||
      a.homeTeamId.localeCompare(b.homeTeamId) ||
      a.awayTeamId.localeCompare(b.awayTeamId),
  )
  byes.sort(
    (a, b) => a.roundNumber - b.roundNumber || a.teamId.localeCompare(b.teamId),
  )

  return { pairings, byes, rounds, notes }
}

/**
 * Adds a bounded number of inter-division games, pairing each division with the
 * next one and taking teams in a deterministic rotation.
 */
function limitedCrossDivision(
  divisions: DivisionInput[],
  config: ScheduleConfig,
  regularRounds: number,
  rng: Rng,
): { pairings: Pairing[]; rounds: number } {
  const pairings: Pairing[] = []
  const ordered = [...divisions].sort((a, b) => a.id.localeCompare(b.id))
  const perTeam = config.crossDivisionGamesPerTeam
  if (perTeam <= 0) return { pairings, rounds: regularRounds }

  let round = regularRounds
  const counts = new Map<string, number>()

  for (let i = 0; i < ordered.length; i++) {
    const left = ordered[i]!
    const right = ordered[(i + 1) % ordered.length]!
    if (left.id === right.id) continue

    const leftTeams = shuffled([...left.teams].sort((a, b) => a.id.localeCompare(b.id)), rng)
    const rightTeams = shuffled([...right.teams].sort((a, b) => a.id.localeCompare(b.id)), rng)
    if (leftTeams.length === 0 || rightTeams.length === 0) continue

    for (let n = 0; n < perTeam; n++) {
      round += 1
      for (const [index, home] of leftTeams.entries()) {
        const away = rightTeams[(index + n) % rightTeams.length]!
        if ((counts.get(home.id) ?? 0) >= perTeam) continue
        if ((counts.get(away.id) ?? 0) >= perTeam) continue
        counts.set(home.id, (counts.get(home.id) ?? 0) + 1)
        counts.set(away.id, (counts.get(away.id) ?? 0) + 1)
        pairings.push({
          divisionId: home.divisionId,
          homeTeamId: home.id,
          awayTeamId: away.id,
          round,
          crossDivision: true,
        })
      }
    }
  }

  return { pairings, rounds: round }
}
