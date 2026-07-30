import { daysBetween, formatTimeOfDay, parseCalendarDate } from '../time'
import type { PlacedGame } from './placement'
import type {
  ByeRecord,
  GeneratedAssignment,
  RefereeInput,
  ScheduleConfig,
  ScheduleReport,
  SlotBucket,
  SoftConstraintReport,
  TeamInput,
  TeamSummary,
  UnfilledPosition,
  UnplacedGame,
} from './types'

/**
 * The post-generation report.
 *
 * The spec asks for "which soft constraints were relaxed, by how much, and for which
 * teams". That is exactly the shape here: one entry per soft constraint, carrying
 * whether it was met, the worst overshoot in its own units, and the teams affected.
 * Hard constraints are absent by construction — a violated hard constraint would have
 * become an unplaced fixture instead.
 */

const BUCKETS: SlotBucket[] = ['early', 'midday', 'late']

function teamSummaries(
  teams: TeamInput[],
  placed: PlacedGame[],
  byes: ByeRecord[],
): TeamSummary[] {
  const summaries = new Map<string, TeamSummary>(
    teams.map((team) => [
      team.id,
      {
        teamId: team.id,
        teamName: team.name,
        divisionId: team.divisionId,
        games: 0,
        home: 0,
        away: 0,
        homeAwayDelta: 0,
        byes: 0,
        venueCounts: {},
        slotBuckets: { early: 0, midday: 0, late: 0 },
        minRestDaysObserved: null,
        consecutiveOpponentRounds: [],
      },
    ]),
  )

  const datesByTeam = new Map<string, string[]>()
  const opponentByRound = new Map<string, Map<number, string>>()

  for (const { pairing, slot } of placed) {
    for (const [teamId, isHome] of [
      [pairing.homeTeamId, true],
      [pairing.awayTeamId, false],
    ] as const) {
      const summary = summaries.get(teamId)
      if (!summary) continue

      summary.games += 1
      if (isHome) summary.home += 1
      else summary.away += 1
      summary.venueCounts[slot.venueId] = (summary.venueCounts[slot.venueId] ?? 0) + 1
      summary.slotBuckets[slot.bucket] += 1

      const dates = datesByTeam.get(teamId) ?? []
      dates.push(slot.date)
      datesByTeam.set(teamId, dates)

      const rounds = opponentByRound.get(teamId) ?? new Map<number, string>()
      rounds.set(pairing.round, isHome ? pairing.awayTeamId : pairing.homeTeamId)
      opponentByRound.set(teamId, rounds)
    }
  }

  for (const bye of byes) {
    const summary = summaries.get(bye.teamId)
    if (summary) summary.byes += 1
  }

  for (const summary of summaries.values()) {
    summary.homeAwayDelta = Math.abs(summary.home - summary.away)

    const dates = (datesByTeam.get(summary.teamId) ?? []).sort()
    if (dates.length >= 2) {
      let smallest = Number.POSITIVE_INFINITY
      for (let i = 1; i < dates.length; i++) {
        const gap = daysBetween(parseCalendarDate(dates[i - 1]!), parseCalendarDate(dates[i]!))
        if (gap < smallest) smallest = gap
      }
      summary.minRestDaysObserved = smallest
    }

    const rounds = opponentByRound.get(summary.teamId)
    if (rounds) {
      for (const [round, opponent] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
        if (rounds.get(round - 1) === opponent) summary.consecutiveOpponentRounds.push(round)
      }
    }
  }

  return [...summaries.values()].sort(
    (a, b) => a.divisionId.localeCompare(b.divisionId) || a.teamName.localeCompare(b.teamName),
  )
}

function softConstraints(
  summaries: TeamSummary[],
  config: ScheduleConfig,
  placedCount: number,
): SoftConstraintReport[] {
  const reports: SoftConstraintReport[] = []

  // --- home / away balance
  {
    const affected = summaries
      .filter((s) => s.games > 0 && s.homeAwayDelta > config.homeAwayBalanceTarget)
      .map((s) => ({
        teamId: s.teamId,
        teamName: s.teamName,
        detail: `${s.home} home, ${s.away} away`,
        magnitude: s.homeAwayDelta - config.homeAwayBalanceTarget,
      }))
    reports.push({
      constraint: 'home_away_balance',
      target: `within ${config.homeAwayBalanceTarget} game${config.homeAwayBalanceTarget === 1 ? '' : 's'} of balanced`,
      relaxed: affected.length > 0,
      magnitude: Math.max(0, ...affected.map((a) => a.magnitude)),
      unit: 'games',
      affected,
    })
  }

  // --- minimum rest days
  {
    const affected = summaries
      .filter((s) => s.minRestDaysObserved !== null && s.minRestDaysObserved < config.minRestDays)
      .map((s) => ({
        teamId: s.teamId,
        teamName: s.teamName,
        detail: `${s.minRestDaysObserved} day${s.minRestDaysObserved === 1 ? '' : 's'} between two games`,
        magnitude: config.minRestDays - (s.minRestDaysObserved ?? 0),
      }))
    reports.push({
      constraint: 'minimum_rest_days',
      target: `at least ${config.minRestDays} day${config.minRestDays === 1 ? '' : 's'} between a team's games`,
      relaxed: affected.length > 0,
      magnitude: Math.max(0, ...affected.map((a) => a.magnitude)),
      unit: 'days',
      affected,
    })
  }

  // --- consecutive opponents
  {
    const affected = summaries
      .filter((s) => s.consecutiveOpponentRounds.length > 0)
      .map((s) => ({
        teamId: s.teamId,
        teamName: s.teamName,
        detail: `same opponent again in round ${s.consecutiveOpponentRounds.join(', ')}`,
        magnitude: s.consecutiveOpponentRounds.length,
      }))
    reports.push({
      constraint: 'avoid_consecutive_opponents',
      target: 'no team meets the same opponent in back-to-back rounds',
      relaxed: affected.length > 0,
      magnitude: Math.max(0, ...affected.map((a) => a.magnitude)),
      unit: 'rounds',
      affected,
    })
  }

  // --- time-slot rotation. A team is "stuck" when more than 60% of its games land
  // in one bucket and it has enough games for that to be meaningful.
  {
    const affected: SoftConstraintReport['affected'] = []
    for (const summary of summaries) {
      if (summary.games < 3) continue
      for (const bucket of BUCKETS) {
        const count = summary.slotBuckets[bucket]
        const share = count / summary.games
        if (share > 0.6) {
          affected.push({
            teamId: summary.teamId,
            teamName: summary.teamName,
            detail: `${count} of ${summary.games} games in the ${bucket} slot`,
            magnitude: Math.round((share - 0.6) * 100),
          })
        }
      }
    }
    reports.push({
      constraint: 'rotate_time_slots',
      target: 'no team gets more than 60% of its games in one time-of-day slot',
      relaxed: affected.length > 0,
      magnitude: Math.max(0, ...affected.map((a) => a.magnitude)),
      unit: 'percentage points',
      affected,
    })
  }

  // --- venue spread, same idea: no team should always travel to one ground.
  {
    const affected: SoftConstraintReport['affected'] = []
    for (const summary of summaries) {
      if (summary.games < 3) continue
      const counts = Object.entries(summary.venueCounts)
      if (counts.length <= 1) continue
      for (const [venueId, count] of counts) {
        const share = count / summary.games
        if (share > 0.75) {
          affected.push({
            teamId: summary.teamId,
            teamName: summary.teamName,
            detail: `${count} of ${summary.games} games at one venue (${venueId})`,
            magnitude: Math.round((share - 0.75) * 100),
          })
        }
      }
    }
    reports.push({
      constraint: 'spread_venues',
      target: 'no team gets more than 75% of its games at a single venue',
      relaxed: affected.length > 0,
      magnitude: Math.max(0, ...affected.map((a) => a.magnitude)),
      unit: 'percentage points',
      affected,
    })
  }

  void placedCount
  return reports
}

export function buildReport(input: {
  config: ScheduleConfig
  teams: TeamInput[]
  placed: PlacedGame[]
  preservedCount: number
  byes: ByeRecord[]
  unplaced: UnplacedGame[]
  assignments: GeneratedAssignment[]
  unfilled: UnfilledPosition[]
  referees: RefereeInput[]
  rounds: number
  notes: string[]
}): ScheduleReport {
  const summaries = teamSummaries(input.teams, input.placed, input.byes)

  const perPosition = Object.values(input.config.officialsRequired).reduce((a, b) => a + b, 0)
  const officialsRequired = input.config.assignOfficials
    ? (input.placed.length + input.preservedCount) * perPosition
    : 0

  const loadById = new Map(
    input.referees.map((referee) => [
      referee.id,
      { refereeId: referee.id, name: referee.name, games: 0, payCents: 0 },
    ]),
  )
  for (const assignment of input.assignments) {
    const load = loadById.get(assignment.refereeId)
    if (!load) continue
    load.games += 1
    load.payCents += assignment.payCents
  }

  return {
    seed: input.config.seed,
    rounds: input.rounds,
    counts: {
      placed: input.placed.length,
      preserved: input.preservedCount,
      unplaced: input.unplaced.length,
      byes: input.byes.length,
      officialsRequired,
      officialsAssigned: input.assignments.length,
    },
    teams: summaries,
    softConstraints: softConstraints(summaries, input.config, input.placed.length),
    unplaced: input.unplaced,
    unfilledOfficials: input.unfilled,
    refereeLoad: [...loadById.values()].sort(
      (a, b) => b.games - a.games || a.name.localeCompare(b.name),
    ),
    notes: input.notes,
  }
}

/** e.g. "Sat 08:00" — for report lines that name a slot without a full timestamp. */
export function describeSlot(date: string, startMinute: number): string {
  const day = new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
  })
  return `${day} ${formatTimeOfDay(startMinute)}`
}
