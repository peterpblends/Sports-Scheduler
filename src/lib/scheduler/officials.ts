import { calendarDateInZone, formatCalendarDate, minutesFromMidnightInZone } from '../time'
import type { CandidateSlot } from './slots'
import type { Pairing } from './pairings'
import type {
  GeneratedAssignment,
  OfficialPosition,
  RefereeInput,
  ScheduleConfig,
  UnfilledPosition,
} from './types'

/**
 * Officiating assignment.
 *
 * The four official-side rules are hard — an official is never assigned in
 * violation of them, and a position that cannot be filled legally is reported
 * unfilled instead:
 *
 *  1. availability (a blackout, or outside every declared weekly window)
 *  2. their daily cap, counted in the venue's local day
 *  3. no overlapping assignment, and enough travel time between venues
 *  4. no conflict of interest — on either team, or related to someone who is
 *
 * Among the officials who pass, the choice balances workload and pay: fewest games
 * so far, then least paid, then preferred-venue match, then id. That ordering is
 * what spreads both the work and the money across the pool.
 */

const POSITION_ORDER: OfficialPosition[] = ['center', 'AR1', 'AR2', 'scorekeeper']

type GameToStaff = {
  gameIndex: number
  pairing: Pick<Pairing, 'homeTeamId' | 'awayTeamId'>
  slot: Pick<CandidateSlot, 'startTime' | 'endTime' | 'venueId' | 'timezone'>
  durationMinutes: number
}

type RefereeState = {
  games: number
  payCents: number
  /** Assignments taken so far, for overlap and travel checks. */
  taken: Array<{ start: number; end: number; venueId: string; localDate: string }>
  perDate: Map<string, number>
}

function unavailable(
  referee: RefereeInput,
  localDate: string,
  startMinute: number,
  endMinute: number,
): string | null {
  const dayOfWeek = new Date(`${localDate}T00:00:00.000Z`).getUTCDay()

  // A blackout wins outright.
  for (const window of referee.availability) {
    if (window.kind !== 'blackout') continue
    if (!window.effectiveFrom || !window.effectiveTo) continue
    if (localDate >= window.effectiveFrom && localDate <= window.effectiveTo) return 'blackout'
  }

  // Declared weekly windows are a whitelist; no declared windows means no stated
  // restriction, which is the useful default while a season is being set up.
  const weekly = referee.availability.filter((w) => w.kind === 'weekly')
  if (weekly.length === 0) return null

  const covered = weekly.some(
    (w) =>
      w.dayOfWeek === dayOfWeek &&
      w.startMinute !== null &&
      w.endMinute !== null &&
      startMinute >= w.startMinute &&
      endMinute <= w.endMinute &&
      (!w.effectiveFrom || localDate >= w.effectiveFrom) &&
      (!w.effectiveTo || localDate <= w.effectiveTo),
  )
  return covered ? null : 'outside_weekly_window'
}

/** Null when this official may take the game; otherwise the rule that blocks them. */
function ineligible(
  referee: RefereeInput,
  state: RefereeState,
  game: GameToStaff,
  localDate: string,
): string | null {
  // 4 — conflict of interest.
  if (
    referee.conflictTeamIds.includes(game.pairing.homeTeamId) ||
    referee.conflictTeamIds.includes(game.pairing.awayTeamId)
  ) {
    return 'conflict_of_interest'
  }

  // 1 — availability, judged in the venue's local time.
  const startMinute = minutesFromMidnightInZone(game.slot.startTime, game.slot.timezone)
  const availabilityIssue = unavailable(
    referee,
    localDate,
    startMinute,
    startMinute + game.durationMinutes,
  )
  if (availabilityIssue) return availabilityIssue

  // 2 — daily cap, in the venue's local day.
  if ((state.perDate.get(localDate) ?? 0) >= referee.maxGamesPerDay) return 'daily_cap'

  // 3 — overlap, and travel time between venues.
  const start = game.slot.startTime.getTime()
  const end = game.slot.endTime.getTime()
  for (const taken of state.taken) {
    if (start < taken.end && taken.start < end) return 'overlapping_assignment'
    if (taken.venueId !== game.slot.venueId) {
      const gap = start >= taken.end ? (start - taken.end) / 60_000 : (taken.start - end) / 60_000
      if (gap < referee.travelBufferMinutes) return 'insufficient_travel_time'
    }
  }

  return null
}

export function assignOfficials(input: {
  games: GameToStaff[]
  referees: RefereeInput[]
  config: ScheduleConfig
}): { assignments: GeneratedAssignment[]; unfilled: UnfilledPosition[] } {
  const { config } = input
  const assignments: GeneratedAssignment[] = []
  const unfilled: UnfilledPosition[] = []

  if (!config.assignOfficials) return { assignments, unfilled }

  const states = new Map<string, RefereeState>()
  for (const referee of input.referees) {
    states.set(referee.id, { games: 0, payCents: 0, taken: [], perDate: new Map() })
  }

  // Chronological, so earlier games get first call on the pool — the same order a
  // human assigner would work in, and stable across runs.
  const games = [...input.games].sort(
    (a, b) => a.slot.startTime.getTime() - b.slot.startTime.getTime() || a.gameIndex - b.gameIndex,
  )
  const referees = [...input.referees].sort((a, b) => a.id.localeCompare(b.id))

  for (const game of games) {
    const localDate = formatCalendarDate(calendarDateInZone(game.slot.startTime, game.slot.timezone))

    for (const position of POSITION_ORDER) {
      const required = config.officialsRequired[position] ?? 0

      for (let n = 0; n < required; n++) {
        const alreadyOnThisGame = new Set(
          assignments.filter((a) => a.gameIndex === game.gameIndex).map((a) => a.refereeId),
        )

        const reasons = new Map<string, number>()
        const eligible = referees.filter((referee) => {
          if (alreadyOnThisGame.has(referee.id)) return false
          const reason = ineligible(referee, states.get(referee.id)!, game, localDate)
          if (reason) {
            reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
            return false
          }
          return true
        })

        if (eligible.length === 0) {
          const ranked = [...reasons.entries()].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          )
          unfilled.push({
            gameIndex: game.gameIndex,
            position,
            reason: referees.length === 0 ? 'no_officials_registered' : (ranked[0]?.[0] ?? 'none_eligible'),
          })
          continue
        }

        // Balance load first, then pay, then honour venue preference.
        eligible.sort((a, b) => {
          const stateA = states.get(a.id)!
          const stateB = states.get(b.id)!
          if (stateA.games !== stateB.games) return stateA.games - stateB.games
          if (stateA.payCents !== stateB.payCents) return stateA.payCents - stateB.payCents

          const prefersA = a.preferredVenueIds.includes(game.slot.venueId) ? 0 : 1
          const prefersB = b.preferredVenueIds.includes(game.slot.venueId) ? 0 : 1
          if (prefersA !== prefersB) return prefersA - prefersB

          return a.id.localeCompare(b.id)
        })

        const chosen = eligible[0]!
        const state = states.get(chosen.id)!
        const payCents = chosen.payRateCents ?? 0

        assignments.push({ gameIndex: game.gameIndex, refereeId: chosen.id, position, payCents })
        state.games += 1
        state.payCents += payCents
        state.taken.push({
          start: game.slot.startTime.getTime(),
          end: game.slot.endTime.getTime(),
          venueId: game.slot.venueId,
          localDate,
        })
        state.perDate.set(localDate, (state.perDate.get(localDate) ?? 0) + 1)
      }
    }
  }

  assignments.sort(
    (a, b) =>
      a.gameIndex - b.gameIndex ||
      POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position),
  )
  unfilled.sort(
    (a, b) =>
      a.gameIndex - b.gameIndex ||
      POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position),
  )

  return { assignments, unfilled }
}
