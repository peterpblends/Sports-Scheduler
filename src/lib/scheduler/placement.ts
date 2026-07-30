import {
  calendarDateInZone,
  daysBetween,
  formatCalendarDate,
  minutesFromMidnightInZone,
  parseCalendarDate,
} from '../time'
import { bucketFor, weekKey, type CandidateSlot } from './slots'
import type { Pairing } from './pairings'
import type {
  BlackoutInput,
  ExistingGameInput,
  ScheduleConfig,
  SiblingGroupInput,
  SlotBucket,
  TeamInput,
} from './types'

/**
 * Greedy placement with backtracking.
 *
 * Hard constraints are absolute: a slot that violates one is never considered, so
 * the engine cannot emit an illegal schedule. If a fixture has no legal slot left,
 * it is reported as unplaced rather than forced.
 *
 * Soft constraints — the fairness targets — are turned into a cost per candidate
 * slot. The cheapest legal slot wins. Whatever cost survives is what the report
 * describes as "relaxed, by this much, for these teams".
 */

export type PlacedGame = {
  pairing: Pairing
  slot: CandidateSlot
}

export type PlacementResult = {
  placed: PlacedGame[]
  unplaced: Array<{ pairing: Pairing; reason: string }>
  /** Slots consumed by preserved games, kept out of the pool. */
  occupiedSlotKeys: Set<string>
  backtrackSteps: number
}

/** Everything the cost function needs to know about what is already scheduled. */
type TeamState = {
  home: number
  away: number
  /** Local dates this team already plays on, ascending. */
  dates: string[]
  venueCounts: Map<string, number>
  bucketCounts: Map<SlotBucket, number>
  /** Round -> opponent, for the consecutive-opponent rule. */
  opponentByRound: Map<number, string>
  gamesPerDate: Map<string, number>
  gamesPerWeek: Map<string, number>
  /** Absolute windows this team is committed to, for the overlap check. */
  windows: Array<{ start: number; end: number }>
}

function emptyTeamState(): TeamState {
  return {
    home: 0,
    away: 0,
    dates: [],
    venueCounts: new Map(),
    bucketCounts: new Map(),
    opponentByRound: new Map(),
    gamesPerDate: new Map(),
    gamesPerWeek: new Map(),
    windows: [],
  }
}

class ScheduleState {
  readonly teams = new Map<string, TeamState>()
  /** Slot key -> true once a game occupies it. */
  readonly usedSlots = new Set<string>()

  team(teamId: string): TeamState {
    let state = this.teams.get(teamId)
    if (!state) {
      state = emptyTeamState()
      this.teams.set(teamId, state)
    }
    return state
  }

  add(pairing: Pairing, slot: CandidateSlot): void {
    this.usedSlots.add(slot.key)
    for (const [teamId, isHome] of [
      [pairing.homeTeamId, true],
      [pairing.awayTeamId, false],
    ] as const) {
      const state = this.team(teamId)
      if (isHome) state.home += 1
      else state.away += 1

      insertSorted(state.dates, slot.date)
      bump(state.venueCounts, slot.venueId)
      bump(state.bucketCounts, slot.bucket)
      state.opponentByRound.set(pairing.round, isHome ? pairing.awayTeamId : pairing.homeTeamId)
      bump(state.gamesPerDate, slot.date)
      bump(state.gamesPerWeek, weekKey(slot.date))
      state.windows.push({ start: slot.startTime.getTime(), end: slot.endTime.getTime() })
    }
  }

  remove(pairing: Pairing, slot: CandidateSlot): void {
    this.usedSlots.delete(slot.key)
    for (const [teamId, isHome] of [
      [pairing.homeTeamId, true],
      [pairing.awayTeamId, false],
    ] as const) {
      const state = this.team(teamId)
      if (isHome) state.home -= 1
      else state.away -= 1

      removeFirst(state.dates, slot.date)
      unbump(state.venueCounts, slot.venueId)
      unbump(state.bucketCounts, slot.bucket)
      state.opponentByRound.delete(pairing.round)
      unbump(state.gamesPerDate, slot.date)
      unbump(state.gamesPerWeek, weekKey(slot.date))

      const start = slot.startTime.getTime()
      const index = state.windows.findIndex((w) => w.start === start)
      if (index >= 0) state.windows.splice(index, 1)
    }
  }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function unbump<K>(map: Map<K, number>, key: K): void {
  const next = (map.get(key) ?? 0) - 1
  if (next <= 0) map.delete(key)
  else map.set(key, next)
}

function insertSorted(list: string[], value: string): void {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (list[mid]! < value) low = mid + 1
    else high = mid
  }
  list.splice(low, 0, value)
}

function removeFirst(list: string[], value: string): void {
  const index = list.indexOf(value)
  if (index >= 0) list.splice(index, 1)
}

// ---------------------------------------------------------------------------
// Hard constraints
// ---------------------------------------------------------------------------

type BlackoutIndex = {
  byDivision: Map<string, Array<{ from: string; to: string }>>
  byTeam: Map<string, Array<{ from: string; to: string }>>
}

function indexBlackouts(blackouts: BlackoutInput[]): BlackoutIndex {
  const byDivision = new Map<string, Array<{ from: string; to: string }>>()
  const byTeam = new Map<string, Array<{ from: string; to: string }>>()

  for (const blackout of blackouts) {
    const range = { from: blackout.startDate, to: blackout.endDate }
    if (blackout.scope === 'division' && blackout.divisionId) {
      const list = byDivision.get(blackout.divisionId) ?? []
      list.push(range)
      byDivision.set(blackout.divisionId, list)
    } else if (blackout.scope === 'team' && blackout.teamId) {
      const list = byTeam.get(blackout.teamId) ?? []
      list.push(range)
      byTeam.set(blackout.teamId, list)
    }
  }
  return { byDivision, byTeam }
}

function blocked(ranges: Array<{ from: string; to: string }> | undefined, date: string): boolean {
  return (ranges ?? []).some((r) => date >= r.from && date <= r.to)
}

/**
 * Why a slot is unusable, or null if it is legal.
 *
 * These are the constraints the spec calls hard, plus the explicit per-team game
 * caps — a cap that can be exceeded is not a cap. Rest days are deliberately *not*
 * here: the spec treats them as a warning, so they are scored instead.
 */
function hardViolation(
  pairing: Pairing,
  slot: CandidateSlot,
  state: ScheduleState,
  config: ScheduleConfig,
  blackouts: BlackoutIndex,
): string | null {
  // Venue capacity / double-booking: one game per field slot.
  if (state.usedSlots.has(slot.key)) return 'field_double_booked'

  const home = state.team(pairing.homeTeamId)
  const away = state.team(pairing.awayTeamId)

  // A team cannot be in two places at once. Separate from the daily cap: raising the
  // cap to allow double-headers must still not let a team play two games at the same
  // moment on different fields.
  const start = slot.startTime.getTime()
  const end = slot.endTime.getTime()
  for (const teamState of [home, away]) {
    for (const window of teamState.windows) {
      if (start < window.end && window.start < end) return 'team_double_booked'
    }
  }

  // Daily and weekly caps.
  if ((home.gamesPerDate.get(slot.date) ?? 0) >= config.maxGamesPerTeamPerDay) {
    return 'home_team_daily_cap'
  }
  if ((away.gamesPerDate.get(slot.date) ?? 0) >= config.maxGamesPerTeamPerDay) {
    return 'away_team_daily_cap'
  }

  const week = weekKey(slot.date)
  if ((home.gamesPerWeek.get(week) ?? 0) >= config.maxGamesPerTeamPerWeek) {
    return 'home_team_weekly_cap'
  }
  if ((away.gamesPerWeek.get(week) ?? 0) >= config.maxGamesPerTeamPerWeek) {
    return 'away_team_weekly_cap'
  }

  // Two fixtures from the same round must not put a team in two places at once;
  // the daily cap covers same-day, this covers the same round landing twice.
  if (home.opponentByRound.has(pairing.round) || away.opponentByRound.has(pairing.round)) {
    return 'team_already_playing_this_round'
  }

  // Blackouts: division- and team-scoped ones depend on who is playing, so they are
  // checked here rather than during slot expansion.
  if (blocked(blackouts.byDivision.get(pairing.divisionId), slot.date)) return 'division_blackout'
  if (blocked(blackouts.byTeam.get(pairing.homeTeamId), slot.date)) return 'home_team_blackout'
  if (blocked(blackouts.byTeam.get(pairing.awayTeamId), slot.date)) return 'away_team_blackout'

  return null
}

// ---------------------------------------------------------------------------
// Soft constraints
// ---------------------------------------------------------------------------

/** Smallest gap in days between `date` and any date already in the sorted list. */
function nearestGap(dates: string[], date: string): number | null {
  if (dates.length === 0) return null
  const target = parseCalendarDate(date)
  let best: number | null = null
  for (const existing of dates) {
    const gap = Math.abs(daysBetween(parseCalendarDate(existing), target))
    if (best === null || gap < best) best = gap
  }
  return best
}

type SiblingIndex = Map<string, string[]>

function indexSiblings(groups: SiblingGroupInput[]): SiblingIndex {
  const index: SiblingIndex = new Map()
  for (const group of groups) {
    for (const teamId of group.teamIds) {
      const others = group.teamIds.filter((id) => id !== teamId)
      index.set(teamId, [...(index.get(teamId) ?? []), ...others])
    }
  }
  return index
}

/**
 * Cost of putting `pairing` in `slot`. Lower is better; every term is a soft
 * constraint scaled by its configured weight.
 */
function cost(
  pairing: Pairing,
  slot: CandidateSlot,
  state: ScheduleState,
  config: ScheduleConfig,
  teamsById: Map<string, TeamInput>,
  siblings: SiblingIndex,
  roundDateIndex: Map<number, number>,
): number {
  const w = config.weights
  const home = state.team(pairing.homeTeamId)
  const away = state.team(pairing.awayTeamId)
  let total = 0

  // --- keep each round near its intended date. Spilling is allowed but costly, so
  // the schedule stays week-shaped unless capacity forces otherwise.
  const targetIndex = roundDateIndex.get(pairing.round)
  if (targetIndex !== undefined) {
    total += w.targetRound * Math.abs(slot.dateIndex - targetIndex)
  }

  // --- home/away balance: charge for widening the gap past the target.
  const homeDeltaAfter = Math.abs(home.home + 1 - home.away)
  const awayDeltaAfter = Math.abs(away.home - (away.away + 1))
  total += w.homeAway * Math.max(0, homeDeltaAfter - config.homeAwayBalanceTarget)
  total += w.homeAway * Math.max(0, awayDeltaAfter - config.homeAwayBalanceTarget)

  // --- avoid the same opponent in consecutive rounds.
  if (
    home.opponentByRound.get(pairing.round - 1) === pairing.awayTeamId ||
    away.opponentByRound.get(pairing.round - 1) === pairing.homeTeamId
  ) {
    total += w.consecutiveOpponent
  }

  // --- rotate early / midday / late so no team is always at 8am.
  total += w.slotRotation * ((home.bucketCounts.get(slot.bucket) ?? 0) + (away.bucketCounts.get(slot.bucket) ?? 0))

  // --- spread venues so no team always travels.
  total += w.venueSpread * ((home.venueCounts.get(slot.venueId) ?? 0) + (away.venueCounts.get(slot.venueId) ?? 0))

  // --- respect minimum rest days. Soft by design: reported, not enforced.
  for (const state_ of [home, away]) {
    const gap = nearestGap(state_.dates, slot.date)
    if (gap !== null && gap < config.minRestDays) {
      total += w.restDays * (config.minRestDays - gap)
    }
  }

  // --- home venue preference is a preference, not a booking.
  const homeTeam = teamsById.get(pairing.homeTeamId)
  if (homeTeam?.preferredVenueId && homeTeam.preferredVenueId !== slot.venueId) {
    total += w.preferredVenue
  }

  // --- keep siblings' games close together: reward a slot on a date a related
  // team already plays, and reward it more when the kickoffs are adjacent.
  const related = [
    ...(siblings.get(pairing.homeTeamId) ?? []),
    ...(siblings.get(pairing.awayTeamId) ?? []),
  ]
  if (related.length > 0) {
    let bestBonus = 0
    for (const teamId of related) {
      const sibling = state.teams.get(teamId)
      if (!sibling) continue
      if ((sibling.gamesPerDate.get(slot.date) ?? 0) > 0) {
        bestBonus = Math.max(bestBonus, 1)
        if ((sibling.venueCounts.get(slot.venueId) ?? 0) > 0) bestBonus = Math.max(bestBonus, 2)
      }
    }
    total -= w.siblingProximity * bestBonus
  }

  return total
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Maps each round to the playable date it should land on. Rounds are one date apart
 * by default, which for a Saturdays-only season means one round per Saturday.
 */
function mapRoundsToDates(rounds: number, slots: CandidateSlot[]): Map<number, number> {
  const dateIndices = [...new Set(slots.map((s) => s.dateIndex))].sort((a, b) => a - b)
  const map = new Map<number, number>()
  for (let round = 1; round <= rounds; round++) {
    // Clamp rather than wrap: with fewer dates than rounds, later rounds all aim at
    // the last date and the spill cost sorts them out.
    const index = Math.min(round - 1, Math.max(0, dateIndices.length - 1))
    map.set(round, dateIndices[index] ?? 0)
  }
  return map
}

/**
 * Turns a preserved game into a slot-shaped record so the fairness counters treat it
 * exactly like a placed game.
 *
 * Derived from the game and its field rather than matched against the candidate
 * pool: a regeneration under a changed config may leave a played game sitting at a
 * time that is no longer a candidate slot, and it still has to count.
 */
function preservedAsSlot(
  game: ExistingGameInput,
  fields: Map<string, { venueId: string; venueName: string; name: string; timezone: string }>,
): CandidateSlot | null {
  if (!game.fieldId) return null
  const field = fields.get(game.fieldId)
  if (!field) return null

  const startMinute = minutesFromMidnightInZone(game.startTime, field.timezone)
  const date = formatCalendarDate(calendarDateInZone(game.startTime, field.timezone))

  return {
    key: `preserved:${game.id}`,
    fieldId: game.fieldId,
    fieldName: field.name,
    venueId: field.venueId,
    venueName: field.venueName,
    timezone: field.timezone,
    date,
    startMinute,
    startTime: game.startTime,
    endTime: new Date(game.startTime.getTime() + game.durationMinutes * 60_000),
    dateIndex: -1,
    bucket: bucketFor(startMinute),
  }
}

/**
 * Drops candidate slots that would collide with a preserved game on the same field,
 * buffer included. Filtering the pool up front is what makes it impossible for a
 * regeneration to double-book a game it was told not to touch — regardless of
 * whether the preserved game lines up with the current slot grid.
 */
function withoutPreservedCollisions(
  slots: CandidateSlot[],
  preserved: ExistingGameInput[],
  config: ScheduleConfig,
): CandidateSlot[] {
  if (preserved.length === 0) return slots
  const buffer = config.bufferMinutes * 60_000

  return slots.filter((slot) => {
    for (const game of preserved) {
      if (game.fieldId !== slot.fieldId) continue
      const gameStart = game.startTime.getTime()
      const gameEnd = gameStart + game.durationMinutes * 60_000
      const slotStart = slot.startTime.getTime() - buffer
      const slotEnd = slot.endTime.getTime() + buffer
      if (slotStart < gameEnd && gameStart < slotEnd) return false
    }
    return true
  })
}

export function placePairings(input: {
  pairings: Pairing[]
  rounds: number
  slots: CandidateSlot[]
  config: ScheduleConfig
  blackouts: BlackoutInput[]
  teams: TeamInput[]
  siblingGroups: SiblingGroupInput[]
  preserved: ExistingGameInput[]
  fields: Map<string, { venueId: string; venueName: string; name: string; timezone: string }>
}): PlacementResult {
  const { pairings, config, teams } = input
  const blackoutIndex = indexBlackouts(input.blackouts)
  const siblings = indexSiblings(input.siblingGroups)
  const teamsById = new Map(teams.map((t) => [t.id, t]))

  // Preserved games take their field time out of the pool before anything is placed.
  const slots = withoutPreservedCollisions(input.slots, input.preserved, config)
  const roundDateIndex = mapRoundsToDates(input.rounds, slots)
  const preservedSlots = input.preserved
    .map((game) => ({ game, slot: preservedAsSlot(game, input.fields) }))
    .filter((entry): entry is { game: ExistingGameInput; slot: CandidateSlot } => entry.slot !== null)

  const occupiedSlotKeys = new Set(preservedSlots.map((entry) => entry.slot.key))

  /** Fresh state with the preserved games already counted. */
  const seedState = (): ScheduleState => {
    const state = new ScheduleState()
    for (const { game, slot } of preservedSlots) {
      state.add(
        {
          divisionId: game.divisionId,
          homeTeamId: game.homeTeamId,
          awayTeamId: game.awayTeamId,
          round: game.roundNumber ?? 0,
          crossDivision: false,
        },
        slot,
      )
    }
    return state
  }

  type Frame = { index: number; pairing: Pairing; options: CandidateSlot[]; chosen: number }

  const unplaced: Array<{ pairing: Pairing; reason: string }> = []
  /** Fixture indices proven to have no arrangement that works. */
  const abandoned = new Set<number>()
  let backtrackSteps = 0
  let stack: Frame[] = []

  /**
   * One pass over the fixture list. Returns the index that could not be placed even
   * after exhausting backtracking, or null once every fixture is settled.
   *
   * On failure the caller records that fixture and re-runs without it. Restarting is
   * O(n) passes at worst but keeps the search obviously correct — no attempt to
   * splice a half-unwound stack back together.
   */
  const attempt = (): number | null => {
    const state = seedState()
    stack = []
    let index = 0

    const rankSlots = (pairing: Pairing): CandidateSlot[] => {
      const options: Array<{ slot: CandidateSlot; score: number }> = []
      for (const slot of slots) {
        if (hardViolation(pairing, slot, state, config, blackoutIndex) !== null) continue
        options.push({
          slot,
          score: cost(pairing, slot, state, config, teamsById, siblings, roundDateIndex),
        })
      }
      // Ties broken by slot key so the choice never depends on iteration order.
      options.sort((a, b) => a.score - b.score || a.slot.key.localeCompare(b.slot.key))
      return options.map((o) => o.slot)
    }

    while (index < pairings.length) {
      if (abandoned.has(index)) {
        index += 1
        continue
      }

      const pairing = pairings[index]!
      const options = rankSlots(pairing)

      if (options.length > 0) {
        state.add(pairing, options[0]!)
        stack.push({ index, pairing, options, chosen: 0 })
        index += 1
        continue
      }

      // Nothing legal here. Unwind and try the next-best slot for an earlier fixture.
      let recovered = false
      while (stack.length > 0 && backtrackSteps < config.maxBacktrackSteps) {
        backtrackSteps += 1
        const frame = stack[stack.length - 1]!
        state.remove(frame.pairing, frame.options[frame.chosen]!)

        if (frame.chosen + 1 < frame.options.length) {
          frame.chosen += 1
          state.add(frame.pairing, frame.options[frame.chosen]!)
          // Resume immediately after the frame we just changed.
          index = frame.index + 1
          recovered = true
          break
        }

        stack.pop()
      }

      if (!recovered) {
        // Either the budget is spent or every arrangement was tried. This fixture
        // cannot be placed without breaking a hard constraint, so give up on it
        // rather than forcing it.
        // Diagnose against the state as it actually stood, not a fresh one — the
        // whole point is to name the constraint that was binding at the time.
        unplaced.push({
          pairing,
          reason: describeFailure(pairing, slots, state, config, blackoutIndex),
        })
        return index
      }
    }

    return null
  }

  let failed = attempt()
  while (failed !== null) {
    abandoned.add(failed)
    failed = attempt()
  }

  const placed = stack.map((frame) => ({
    pairing: frame.pairing,
    slot: frame.options[frame.chosen]!,
  }))
  placed.sort(
    (a, b) =>
      a.slot.startTime.getTime() - b.slot.startTime.getTime() || a.slot.key.localeCompare(b.slot.key),
  )

  return { placed, unplaced, occupiedSlotKeys, backtrackSteps }
}

/** The most common reason a fixture had nowhere to go, for the report. */
function describeFailure(
  pairing: Pairing,
  slots: CandidateSlot[],
  state: ScheduleState,
  config: ScheduleConfig,
  blackouts: BlackoutIndex,
): string {
  if (slots.length === 0) return 'no_slots_available'
  const tally = new Map<string, number>()
  for (const slot of slots) {
    const reason = hardViolation(pairing, slot, state, config, blackouts)
    if (reason) bump(tally, reason)
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return ranked[0]?.[0] ?? 'no_feasible_slot'
}
