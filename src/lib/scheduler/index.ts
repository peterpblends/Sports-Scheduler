import { resolveConfig } from './config'
import { placePairings } from './placement'
import { buildPairings } from './pairings'
import { assignOfficials } from './officials'
import { buildBracket, computeStandings } from './playoffs'
import { createRng } from './random'
import { buildReport } from './report'
import { expandSlots, type CandidateSlot } from './slots'
import type {
  GeneratedGame,
  ScheduleResult,
  SchedulerInput,
  TeamInput,
  UnplacedGame,
} from './types'

export * from './types'
export { DEFAULT_CONFIG, resolveConfig, scheduleConfigSchema } from './config'
export { computeStandings, buildBracket } from './playoffs'
export { expandSlots, playableDates } from './slots'

/**
 * The scheduling engine.
 *
 * A pure function: config and entities in, games out. No database, no clock, no
 * `Math.random()`. That is what makes it unit-testable from fixtures and what makes
 * the idempotence guarantee — same config, same seed, same entities, same schedule —
 * something the tests can actually assert.
 *
 * The shape of a run:
 *   1. resolve config, seed the RNG
 *   2. expand field availability rules into concrete UTC slots
 *   3. build the fixture list from the round robin
 *   4. drop fixtures that a regeneration must leave alone
 *   5. place fixtures into slots — hard constraints absolute, fairness scored
 *   6. assign officials
 *   7. optionally reserve playoff slots
 *   8. report what was relaxed
 */
export function generateSchedule(input: SchedulerInput): ScheduleResult {
  const config = resolveConfig(input.config)
  const rng = createRng(config.seed)
  const notes: string[] = []

  const teams: TeamInput[] = input.divisions.flatMap((d) => d.teams)
  const fieldsById = new Map(
    input.fields.map((field) => [
      field.id,
      {
        venueId: field.venueId,
        venueName: field.venueName,
        name: field.name,
        timezone: field.timezone,
      },
    ]),
  )

  // --- 2. slots
  const allSlots = expandSlots(input.fields, config, input.season, input.blackouts)
  if (allSlots.length === 0) {
    notes.push(
      'No bookable slots in the season window. Check playable days, field time slots ' +
        'and the earliest/latest start times.',
    )
  }

  // --- 3. fixtures
  const plan = buildPairings(input.divisions, config, rng.fork('pairings'))
  notes.push(...plan.notes)

  const dates = new Set(allSlots.map((s) => s.date))
  if (input.config.numberOfRounds == null && plan.rounds > dates.size && dates.size > 0) {
    notes.push(
      `The round robin needs ${plan.rounds} rounds but the season has only ${dates.size} ` +
        `playable date${dates.size === 1 ? '' : 's'}; later rounds share dates.`,
    )
  }

  // --- 4. preserved games
  const existing = input.existingGames ?? []
  const preserved = existing.filter((game) => config.preserveStatuses.includes(game.status))
  if (preserved.length > 0) {
    notes.push(
      `Preserved ${preserved.length} existing game${preserved.length === 1 ? '' : 's'} ` +
        `with status ${config.preserveStatuses.join(', ')}; their fixtures were not regenerated.`,
    )
  }

  // A fixture already satisfied by a preserved game must not be generated again.
  const preservedFixtures = new Set(
    preserved.map((game) => fixtureKey(game.homeTeamId, game.awayTeamId)),
  )
  const pairings = plan.pairings.filter(
    (p) => !preservedFixtures.has(fixtureKey(p.homeTeamId, p.awayTeamId)),
  )
  const droppedForPreserved = plan.pairings.length - pairings.length
  if (droppedForPreserved > 0) {
    notes.push(
      `${droppedForPreserved} generated fixture${droppedForPreserved === 1 ? '' : 's'} ` +
        'already existed as a preserved game and were skipped.',
    )
  }

  // --- 5. placement
  const placement = placePairings({
    pairings,
    rounds: plan.rounds,
    slots: allSlots,
    config,
    blackouts: input.blackouts,
    teams,
    siblingGroups: input.siblingGroups ?? [],
    preserved,
    fields: fieldsById,
  })

  if (placement.backtrackSteps >= config.maxBacktrackSteps) {
    notes.push(
      `Backtracking hit its ${config.maxBacktrackSteps}-step budget; ` +
        'some fixtures may be reported unplaced that a longer search could seat.',
    )
  }

  // --- assemble the games list: preserved first, then newly placed
  const games: GeneratedGame[] = []

  for (const game of preserved) {
    if (!game.fieldId) continue
    games.push({
      existingId: game.id,
      divisionId: game.divisionId,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      fieldId: game.fieldId,
      startTime: game.startTime,
      durationMinutes: game.durationMinutes,
      roundNumber: game.roundNumber ?? 0,
      preserved: true,
    })
  }

  for (const { pairing, slot } of placement.placed) {
    games.push({
      existingId: null,
      divisionId: pairing.divisionId,
      homeTeamId: pairing.homeTeamId,
      awayTeamId: pairing.awayTeamId,
      fieldId: slot.fieldId,
      startTime: slot.startTime,
      durationMinutes: config.gameDurationMinutes,
      roundNumber: pairing.round,
      preserved: false,
    })
  }

  // --- byes only count for rounds that actually happened. A round the engine could
  // not seat gives nobody a rest — reporting it as a bye would overstate the season.
  const placedRounds = new Set(placement.placed.map((p) => p.pairing.round))
  const byes = plan.byes.filter((bye) => placedRounds.has(bye.roundNumber))
  const droppedByes = plan.byes.length - byes.length
  if (droppedByes > 0) {
    notes.push(
      `${droppedByes} round${droppedByes === 1 ? '' : 's'} could not be seated at all, ` +
        'so their byes are not counted.',
    )
  }

  // --- 7. playoffs, appended after the regular season
  const usedSlotKeys = new Set([
    ...placement.occupiedSlotKeys,
    ...placement.placed.map((p) => p.slot.key),
  ])
  const playoffGames = config.playoffs.enabled
    ? reservePlayoffSlots({
        divisions: input.divisions,
        existing,
        allSlots,
        usedSlotKeys,
        config,
        notes,
        lastRegularRound: Math.max(0, ...games.map((g) => g.roundNumber)),
        // Playoffs must sit after everything already scheduled, and must not put a
        // team in two places at once.
        regularGames: games.map((g) => ({
          startTime: g.startTime,
          durationMinutes: g.durationMinutes,
          homeTeamId: g.homeTeamId,
          awayTeamId: g.awayTeamId,
        })),
      })
    : []
  games.push(...playoffGames)

  // --- 6. officials, over every game that has a field and a known matchup
  const staffable = games
    .map((game, gameIndex) => ({ game, gameIndex }))
    .filter(({ game }) => !game.preserved && game.homeTeamId && game.awayTeamId)
    .map(({ game, gameIndex }) => {
      const field = fieldsById.get(game.fieldId)!
      return {
        gameIndex,
        pairing: { homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId },
        slot: {
          startTime: game.startTime,
          endTime: new Date(game.startTime.getTime() + game.durationMinutes * 60_000),
          venueId: field.venueId,
          timezone: field.timezone,
        },
        durationMinutes: game.durationMinutes,
      }
    })

  const officials = assignOfficials({ games: staffable, referees: input.referees, config })

  // --- 8. report
  const teamNames = new Map(teams.map((t) => [t.id, t.name]))
  const unplaced: UnplacedGame[] = placement.unplaced.map(({ pairing, reason }) => ({
    divisionId: pairing.divisionId,
    homeTeamId: pairing.homeTeamId,
    awayTeamId: pairing.awayTeamId,
    roundNumber: pairing.round,
    reason: `${teamNames.get(pairing.homeTeamId) ?? pairing.homeTeamId} v ` +
      `${teamNames.get(pairing.awayTeamId) ?? pairing.awayTeamId}: ${reason}`,
  }))

  const report = buildReport({
    config,
    teams,
    placed: placement.placed,
    preservedCount: preserved.length,
    byes,
    unplaced,
    assignments: officials.assignments,
    unfilled: officials.unfilled,
    referees: input.referees,
    rounds: plan.rounds,
    notes,
  })

  return { config, games, assignments: officials.assignments, byes, report }
}

/** Order-independent key, so a home/away reversal counts as the same fixture. */
function fixtureKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Reserves calendar space for a playoff bracket after the regular season.
 *
 * At initial generation there are no results, so seeding falls back to a
 * provisional order and the report says so. Regenerating once games have been played
 * seeds from the real table.
 */
function reservePlayoffSlots(input: {
  divisions: SchedulerInput['divisions']
  existing: SchedulerInput['existingGames']
  allSlots: CandidateSlot[]
  usedSlotKeys: Set<string>
  config: ReturnType<typeof resolveConfig>
  notes: string[]
  lastRegularRound: number
  regularGames: Array<{
    startTime: Date
    durationMinutes: number
    homeTeamId: string
    awayTeamId: string
  }>
}): GeneratedGame[] {
  const { config, notes } = input
  const games: GeneratedGame[] = []
  const used = new Set(input.usedSlotKeys)

  // The bracket starts after the regular season has finished.
  const seasonEnds = Math.max(
    0,
    ...input.regularGames.map((g) => g.startTime.getTime() + g.durationMinutes * 60_000),
  )

  /** Windows each team is already committed to, so a bracket slot cannot clash. */
  const commitments = new Map<string, Array<{ start: number; end: number }>>()
  for (const game of input.regularGames) {
    const window = {
      start: game.startTime.getTime(),
      end: game.startTime.getTime() + game.durationMinutes * 60_000,
    }
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      if (!teamId) continue
      commitments.set(teamId, [...(commitments.get(teamId) ?? []), window])
    }
  }

  const clashes = (teamIds: string[], slot: CandidateSlot): boolean =>
    teamIds.some((teamId) =>
      (commitments.get(teamId) ?? []).some(
        (window) => slot.startTime.getTime() < window.end && window.start < slot.endTime.getTime(),
      ),
    )

  const commit = (teamIds: string[], slot: CandidateSlot): void => {
    const window = { start: slot.startTime.getTime(), end: slot.endTime.getTime() }
    for (const teamId of teamIds) {
      if (!teamId) continue
      commitments.set(teamId, [...(commitments.get(teamId) ?? []), window])
    }
  }

  for (const division of [...input.divisions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (division.teams.length < 2) continue

    const played = (input.existing ?? []).filter(
      (game) => game.divisionId === division.id && game.status === 'played',
    )
    const standings = computeStandings(division.teams, played)
    const hasResults = standings.some((row) => row.played > 0)

    if (!hasResults || config.playoffs.seeding === 'provisional') {
      notes.push(
        `Playoff seeding for ${division.name} is provisional — no results yet, so seeds ` +
          'follow the standings order with every team on zero points. Regenerate once ' +
          'games have been played to seed properly.',
      )
    }

    const seeds = standings.slice(0, config.playoffs.teams).map((row) => row.teamId)
    const bracket = buildBracket(seeds, config.playoffs.format, division.name)

    // Earliest free slot after the regular season that neither side is busy for.
    // Later bracket rounds have unknown teams, so only round 1 can clash.
    for (const match of bracket) {
      const teamIds = [match.homeTeamId, match.awayTeamId].filter((id): id is string => !!id)
      const slot = input.allSlots.find(
        (candidate) =>
          !used.has(candidate.key) &&
          candidate.startTime.getTime() >= seasonEnds &&
          !clashes(teamIds, candidate),
      )
      if (!slot) {
        notes.push(`Ran out of slots after the regular season before placing ${match.label}.`)
        continue
      }
      used.add(slot.key)
      commit(teamIds, slot)
      games.push({
        existingId: null,
        divisionId: division.id,
        // Later rounds are decided by earlier ones, so their teams are unknown here.
        homeTeamId: match.homeTeamId ?? '',
        awayTeamId: match.awayTeamId ?? '',
        fieldId: slot.fieldId,
        startTime: slot.startTime,
        durationMinutes: config.gameDurationMinutes,
        roundNumber: input.lastRegularRound + match.round,
        preserved: false,
        bracket: { round: match.round, matchIndex: match.matchIndex, label: match.label },
      })
    }
  }

  return games
}
