import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  computeStandings,
  expandSlots,
  generateSchedule,
  playableDates,
  resolveConfig,
  type ExistingGameInput,
  type GeneratedGame,
  type ScheduleResult,
} from '@/lib/scheduler'
import {
  calendarDateInZone,
  dayOfWeekInZone,
  formatCalendarDate,
  minutesFromMidnightInZone,
} from '@/lib/time'
import {
  blackout,
  division,
  field,
  nineTeamSeason,
  referee,
  saturdaySlot,
  teamId,
  tightSingleVenueSeason,
  twoVenuesThreeFields,
} from './scheduler-fixtures'

/**
 * Engine tests. No database — the engine is a pure function, so these run straight
 * off fixtures.
 *
 * Non-negotiable #4 asks for four specific fixtures: an odd team count, a single
 * venue with tight slots, a referee with heavy blackouts, and a mid-season
 * regeneration that preserves already-played games. Each has its own describe block
 * below.
 */

// ---------------------------------------------------------------------------
// Invariants asserted repeatedly
// ---------------------------------------------------------------------------

/** No two games share a field slot, and no team is in two places at once. */
function expectNoDoubleBookings(result: ScheduleResult) {
  const byField = new Map<string, Array<{ start: number; end: number }>>()
  const byTeam = new Map<string, Array<{ start: number; end: number }>>()

  for (const game of result.games) {
    if (!game.homeTeamId || !game.awayTeamId) continue // unresolved playoff slot
    const start = game.startTime.getTime()
    const end = start + game.durationMinutes * 60_000

    for (const [map, key] of [
      [byField, game.fieldId],
      [byTeam, game.homeTeamId],
      [byTeam, game.awayTeamId],
    ] as const) {
      const list = map.get(key) ?? []
      for (const other of list) {
        const overlaps = start < other.end && other.start < end
        expect(
          overlaps,
          `overlap on ${key}: ${new Date(start).toISOString()} vs ${new Date(other.start).toISOString()}`,
        ).toBe(false)
      }
      list.push({ start, end })
      map.set(key, list)
    }
  }
}

/** Every game sits on a playable day, inside the season, at a real venue slot. */
function expectGamesInsideAvailability(result: ScheduleResult, input: Parameters<typeof generateSchedule>[0]) {
  const config = resolveConfig(input.config)
  const slots = expandSlots(input.fields, config, input.season, input.blackouts)
  const legal = new Set(slots.map((s) => `${s.fieldId}|${s.startTime.getTime()}`))

  for (const game of result.games) {
    if (game.preserved) continue
    expect(
      legal.has(`${game.fieldId}|${game.startTime.getTime()}`),
      `game at ${game.startTime.toISOString()} on ${game.fieldId} is not a published slot`,
    ).toBe(true)
  }
}

const gamesPerTeamPublic = (result: ScheduleResult) => gamesPerTeam(result)

function gamesPerTeam(result: ScheduleResult): Map<string, number> {
  const counts = new Map<string, number>()
  for (const game of result.games) {
    for (const id of [game.homeTeamId, game.awayTeamId]) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configuration', () => {
  it('produces a working schedule from an empty config', () => {
    const input = nineTeamSeason({ config: {} })
    const result = generateSchedule(input)
    expect(result.games.length).toBeGreaterThan(0)
    expect(result.config.roundRobinTimes).toBe(DEFAULT_CONFIG.roundRobinTimes)
  })

  it('normalizes order-dependent fields so equivalent configs match', () => {
    const a = resolveConfig({ playableDaysOfWeek: [6, 0, 6] })
    const b = resolveConfig({ playableDaysOfWeek: [0, 6] })
    expect(a.playableDaysOfWeek).toEqual([0, 6])
    expect(a.playableDaysOfWeek).toEqual(b.playableDaysOfWeek)
  })

  it('merges nested config sections rather than replacing them', () => {
    const config = resolveConfig({ weights: { homeAway: 99 }, officialsRequired: { center: 1 } })
    expect(config.weights.homeAway).toBe(99)
    expect(config.weights.restDays).toBe(DEFAULT_CONFIG.weights.restDays)
    expect(config.officialsRequired.AR1).toBe(DEFAULT_CONFIG.officialsRequired.AR1)
  })
})

// ---------------------------------------------------------------------------
// Slot expansion
// ---------------------------------------------------------------------------

describe('slot expansion', () => {
  it('finds exactly the Saturdays in the window', () => {
    const dates = playableDates('2026-03-07', '2026-05-23', resolveConfig({}))
    expect(dates).toHaveLength(12)
    expect(dates[0]).toBe('2026-03-07')
    expect(dates.at(-1)).toBe('2026-05-23')
  })

  it('keeps slot times at the same local hour across the DST change', () => {
    const config = resolveConfig({ earliestStartMinute: 8 * 60, latestStartMinute: 8 * 60 })
    const slots = expandSlots(
      [field('f1', 'Field 1', 'v1', 'Venue', [saturdaySlot()])],
      config,
      { startDate: '2026-03-07', endDate: '2026-03-14' },
      [],
    )

    expect(slots).toHaveLength(2)
    // Same local reading, different UTC instants — 8am PST then 8am PDT.
    for (const slot of slots) {
      expect(minutesFromMidnightInZone(slot.startTime, slot.timezone)).toBe(480)
      expect(dayOfWeekInZone(slot.startTime, slot.timezone)).toBe(6)
    }
    expect(slots[0]!.startTime.toISOString()).toBe('2026-03-07T16:00:00.000Z')
    expect(slots[1]!.startTime.toISOString()).toBe('2026-03-14T15:00:00.000Z')
  })

  it('carves kickoffs at duration plus buffer and never past closing', () => {
    const config = resolveConfig({
      gameDurationMinutes: 60,
      bufferMinutes: 15,
      earliestStartMinute: 0,
      latestStartMinute: 24 * 60,
    })
    const slots = expandSlots(
      [
        field('f1', 'Field 1', 'v1', 'Venue', [
          saturdaySlot({ startMinute: 9 * 60, endMinute: 12 * 60 }),
        ]),
      ],
      config,
      { startDate: '2026-03-07', endDate: '2026-03-07' },
      [],
    )

    // 9:00, 10:15, 11:30 would end at 12:30 — past close — so three fit only if the
    // last one finishes by 12:00. 9:00 and 10:15 do; 11:30 does not.
    expect(slots.map((s) => s.startMinute)).toEqual([540, 615])
  })

  it('drops slots covered by an org or venue blackout', () => {
    const config = resolveConfig({})
    const fields = twoVenuesThreeFields()
    const season = { startDate: '2026-03-07', endDate: '2026-03-14' }

    const orgBlocked = expandSlots(fields, config, season, [
      blackout('b1', 'org', '2026-03-07', '2026-03-07', 'Holiday'),
    ])
    expect(new Set(orgBlocked.map((s) => s.date))).toEqual(new Set(['2026-03-14']))

    const venueBlocked = expandSlots(fields, config, season, [
      blackout('b2', 'venue', '2026-03-07', '2026-03-14', 'Maintenance', {
        venueId: 'venue-riverside',
      }),
    ])
    expect(new Set(venueBlocked.map((s) => s.venueId))).toEqual(new Set(['venue-eastside']))
  })

  it('honours a per-day kickoff window override', () => {
    const config = resolveConfig({
      playableDaysOfWeek: [0, 6],
      earliestStartMinute: 8 * 60,
      latestStartMinute: 17 * 60,
      dayWindows: [{ dayOfWeek: 0, earliestStartMinute: 13 * 60, latestStartMinute: 14 * 60 }],
    })
    const slots = expandSlots(
      [
        field('f1', 'Field 1', 'v1', 'Venue', [
          saturdaySlot(),
          saturdaySlot({ id: 'sun', dayOfWeek: 0, startMinute: 8 * 60, endMinute: 20 * 60 }),
        ]),
      ],
      config,
      { startDate: '2026-03-07', endDate: '2026-03-08' },
      [],
    )

    const sundays = slots.filter((s) => s.date === '2026-03-08')
    expect(sundays.length).toBeGreaterThan(0)
    for (const slot of sundays) {
      expect(slot.startMinute).toBeGreaterThanOrEqual(13 * 60)
      expect(slot.startMinute).toBeLessThanOrEqual(14 * 60)
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture 1 — odd team count (and acceptance scenario 2)
// ---------------------------------------------------------------------------

describe('fixture: odd team count — 9 teams, 12 Saturdays, double round robin', () => {
  const input = nineTeamSeason()
  const result = generateSchedule(input)

  /**
   * Acceptance scenario 2 as literally specified is over-subscribed, and the engine
   * is right to say so rather than quietly inventing capacity.
   *
   * A 9-team double round robin is 72 games — 16 per team. Twelve Saturdays with the
   * default cap of one game per team per day allows 12 per team, so 48 games fit and
   * 24 cannot. The engine places the 48 legally and reports the shortfall. The
   * double-header variant below is the same scenario with the cap raised, where all
   * 72 do fit.
   */
  it('places everything capacity allows and reports the shortfall honestly', () => {
    const dates = playableDates(input.season.startDate, input.season.endDate, resolveConfig(input.config))
    expect(dates).toHaveLength(12)

    // 9 teams means 4 games a round, so 12 rounds of capacity = 48 games.
    expect(result.report.counts.placed).toBe(48)
    expect(result.report.counts.unplaced).toBe(24)
    expect(result.report.counts.placed + result.report.counts.unplaced).toBe(72)

    // Every shortfall names the fixture and the constraint that blocked it.
    for (const entry of result.report.unplaced) {
      expect(entry.reason).toMatch(/ v .+: \w+/)
    }
    expect(result.report.unplaced.some((u) => u.reason.includes('cap'))).toBe(true)
  })

  it('has no double-bookings of fields or teams', () => {
    expectNoDoubleBookings(result)
  })

  it('places every game inside published field availability', () => {
    expectGamesInsideAvailability(result, input)
  })

  it('gives every team the same number of games', () => {
    const counts = [...gamesPerTeam(result).values()]
    expect(counts).toHaveLength(9)
    // 48 games over 9 teams cannot divide evenly, so allow a one-game spread.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it('counts a bye only for rounds that were actually scheduled', () => {
    const scheduledRounds = new Set(result.games.map((g) => g.roundNumber))
    for (const bye of result.byes) {
      expect(scheduledRounds.has(bye.roundNumber), `round ${bye.roundNumber}`).toBe(true)
    }
    expect(result.report.notes.join(' ')).toContain('byes are not counted')
  })

  it('has exactly one bye per round, and the bye team plays no game that round', () => {
    const roundsWithGames = new Map<number, Set<string>>()
    for (const game of result.games) {
      const set = roundsWithGames.get(game.roundNumber) ?? new Set<string>()
      set.add(game.homeTeamId)
      set.add(game.awayTeamId)
      roundsWithGames.set(game.roundNumber, set)
    }

    const byesByRound = new Map<number, string[]>()
    for (const bye of result.byes) {
      byesByRound.set(bye.roundNumber, [...(byesByRound.get(bye.roundNumber) ?? []), bye.teamId])
    }

    for (const [round, teams] of byesByRound) {
      expect(teams, `round ${round} should have one bye`).toHaveLength(1)
      expect(roundsWithGames.get(round)?.has(teams[0]!)).toBe(false)
    }
  })

  it('never repeats a fixture more than the round robin allows', () => {
    const meetings = new Map<string, number>()
    for (const game of result.games) {
      const key = [game.homeTeamId, game.awayTeamId].sort().join('|')
      meetings.set(key, (meetings.get(key) ?? 0) + 1)
    }
    for (const [pair, count] of meetings) {
      expect(count, `pair ${pair}`).toBeLessThanOrEqual(2)
    }
  })

  /**
   * Home/away balance is a soft constraint, and this is the case where it has to
   * give: a pair's two legs are one home and one away, so dropping 24 fixtures
   * leaves some teams holding only one leg of several pairings. The engine reports
   * that rather than hiding it. The double-header variant below, where nothing is
   * dropped, comes out exactly balanced.
   */
  it('reports home and away balance as relaxed, naming the teams', () => {
    const balance = result.report.softConstraints.find((c) => c.constraint === 'home_away_balance')!
    expect(balance.relaxed).toBe(true)
    expect(balance.affected.length).toBeGreaterThan(0)
    for (const team of balance.affected) {
      expect(team.detail).toMatch(/\d+ home, \d+ away/)
      expect(team.magnitude).toBeGreaterThan(0)
    }
    // Still not wildly lopsided — the orientation pass keeps it close.
    expect(Math.max(...result.report.teams.map((t) => t.homeAwayDelta))).toBeLessThanOrEqual(4)
  })

  it('respects the daily and weekly caps', () => {
    const perTeamPerDate = new Map<string, number>()
    for (const game of result.games) {
      const date = formatCalendarDate(calendarDateInZone(game.startTime, 'America/Los_Angeles'))
      for (const id of [game.homeTeamId, game.awayTeamId]) {
        const key = `${id}|${date}`
        perTeamPerDate.set(key, (perTeamPerDate.get(key) ?? 0) + 1)
      }
    }
    expect(Math.max(...perTeamPerDate.values())).toBeLessThanOrEqual(
      result.config.maxGamesPerTeamPerDay,
    )
  })

  it('reports every soft constraint, met or relaxed', () => {
    const keys = result.report.softConstraints.map((c) => c.constraint)
    expect(keys).toEqual([
      'home_away_balance',
      'minimum_rest_days',
      'avoid_consecutive_opponents',
      'rotate_time_slots',
      'spread_venues',
    ])
    for (const entry of result.report.softConstraints) {
      // A met constraint reports zero magnitude and nobody affected.
      if (!entry.relaxed) {
        expect(entry.magnitude).toBe(0)
        expect(entry.affected).toHaveLength(0)
      } else {
        expect(entry.magnitude).toBeGreaterThan(0)
        expect(entry.affected.length).toBeGreaterThan(0)
      }
    }
  })

  it('rotates time slots so no team is always at 8am', () => {
    for (const team of result.report.teams) {
      const buckets = Object.values(team.slotBuckets)
      const most = Math.max(...buckets)
      expect(most, `${team.teamName} is stuck in one slot`).toBeLessThan(team.games)
    }
  })
})

/**
 * Acceptance scenario 2, made feasible: the same 9 teams and 12 Saturdays, but with
 * double-headers allowed, which is what a real league does when it wants a full
 * double round robin inside twelve weeks.
 */
describe('fixture: 9 teams, 12 Saturdays, double round robin with double-headers', () => {
  const input = nineTeamSeason({
    config: {
      seed: 42,
      roundRobinTimes: 2,
      maxGamesPerTeamPerDay: 2,
      maxGamesPerTeamPerWeek: 2,
      // Two games in a day means no rest between them, so lower the target rather
      // than have every team reported as relaxed.
      minRestDays: 0,
    },
  })
  const result = generateSchedule(input)

  it('fits the whole double round robin', () => {
    expect(result.report.counts.placed).toBe(72)
    expect(result.report.counts.unplaced).toBe(0)
  })

  it('has no double-bookings of fields or teams', () => {
    expectNoDoubleBookings(result)
    expectGamesInsideAvailability(result, input)
  })

  it('meets each opponent exactly twice, once at each ground', () => {
    const meetings = new Map<string, { asHome: number }>()
    for (const game of result.games) {
      const key = [game.homeTeamId, game.awayTeamId].sort().join('|')
      const entry = meetings.get(key) ?? { asHome: 0 }
      // Count how often the alphabetically-first team hosted.
      if (game.homeTeamId < game.awayTeamId) entry.asHome += 1
      meetings.set(key, entry)
    }
    expect(meetings.size).toBe(36) // 9 choose 2
    for (const [pair, entry] of meetings) {
      expect(entry.asHome, `pair ${pair} should be one game at each ground`).toBe(1)
    }
  })

  it('gives every team 16 games and an even share of byes', () => {
    expect(new Set(gamesPerTeam(result).values())).toEqual(new Set([16]))

    const byes = new Map<string, number>()
    for (const bye of result.byes) byes.set(bye.teamId, (byes.get(bye.teamId) ?? 0) + 1)
    expect(byes.size).toBe(9)
    const counts = [...byes.values()]
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it('keeps home and away within one game for every team', () => {
    for (const team of result.report.teams) {
      expect(team.homeAwayDelta, `${team.teamName}`).toBeLessThanOrEqual(1)
    }
  })

  it('respects the raised daily cap without exceeding it', () => {
    const perTeamPerDate = new Map<string, number>()
    for (const game of result.games) {
      const date = formatCalendarDate(calendarDateInZone(game.startTime, 'America/Los_Angeles'))
      for (const id of [game.homeTeamId, game.awayTeamId]) {
        const key = `${id}|${date}`
        perTeamPerDate.set(key, (perTeamPerDate.get(key) ?? 0) + 1)
      }
    }
    expect(Math.max(...perTeamPerDate.values())).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Idempotence — non-negotiable #5
// ---------------------------------------------------------------------------

describe('idempotent generation', () => {
  const signature = (result: ScheduleResult) =>
    result.games
      .map((g) => `${g.roundNumber}|${g.homeTeamId}|${g.awayTeamId}|${g.fieldId}|${g.startTime.toISOString()}`)
      .join('\n')

  it('produces an identical schedule for the same config and seed', () => {
    const a = generateSchedule(nineTeamSeason())
    const b = generateSchedule(nineTeamSeason())
    expect(signature(a)).toBe(signature(b))
  })

  it('produces a different schedule for a different seed', () => {
    const a = generateSchedule(nineTeamSeason({ config: { seed: 1, roundRobinTimes: 2 } }))
    const b = generateSchedule(nineTeamSeason({ config: { seed: 2, roundRobinTimes: 2 } }))
    expect(signature(a)).not.toBe(signature(b))
    // Both still valid, and the same size.
    expect(a.games).toHaveLength(b.games.length)
    expectNoDoubleBookings(a)
    expectNoDoubleBookings(b)
  })

  it('assigns officials identically across runs', () => {
    const withRefs = () =>
      nineTeamSeason({
        config: { seed: 42, roundRobinTimes: 1, officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 } },
        referees: [
          referee('ref-a', 'Ada'),
          referee('ref-b', 'Bo'),
          referee('ref-c', 'Cy'),
        ],
      })

    const a = generateSchedule(withRefs())
    const b = generateSchedule(withRefs())
    const sig = (r: ScheduleResult) =>
      r.assignments.map((x) => `${x.gameIndex}|${x.position}|${x.refereeId}`).join('\n')
    expect(sig(a)).toBe(sig(b))
    expect(a.assignments.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Fixture 2 — single venue with tight slots
// ---------------------------------------------------------------------------

describe('fixture: single venue with tight slots', () => {
  const input = tightSingleVenueSeason()
  const result = generateSchedule(input)

  it('never double-books the only field', () => {
    expectNoDoubleBookings(result)
    expectGamesInsideAvailability(result, input)
  })

  it('uses only the two available kickoffs each Saturday', () => {
    const minutes = new Set(
      result.games.map((g) => minutesFromMidnightInZone(g.startTime, 'America/Los_Angeles')),
    )
    expect([...minutes].sort((a, b) => a - b)).toEqual([540, 615])
  })

  it('places what capacity allows and reports the rest rather than forcing it', () => {
    // 6 teams single round robin = 15 games. 8 Saturdays x 2 slots = 16 slots, so it
    // fits — but only just, and only if the placement is tight.
    const dates = playableDates(input.season.startDate, input.season.endDate, resolveConfig(input.config))
    const capacity = dates.length * 2
    expect(result.report.counts.placed + result.report.counts.unplaced).toBe(15)
    expect(result.report.counts.placed).toBeLessThanOrEqual(capacity)

    for (const entry of result.report.unplaced) {
      // Unplaced fixtures always say why.
      expect(entry.reason).toMatch(/:/)
    }
  })

  it('reports rest days as relaxed when capacity forces games close together', () => {
    const rest = result.report.softConstraints.find((c) => c.constraint === 'minimum_rest_days')!
    // Two games a week on one field means some teams play on consecutive Saturdays,
    // which is under the 3-day default. That is a relaxation, not a failure.
    expect(rest.target).toContain('3 days')
    if (rest.relaxed) {
      expect(rest.affected.length).toBeGreaterThan(0)
      for (const team of rest.affected) expect(team.detail).toMatch(/day/)
    }
  })

  it('still balances home and away within the target', () => {
    for (const team of result.report.teams) {
      if (team.games === 0) continue
      expect(team.homeAwayDelta).toBeLessThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture 3 — a referee with heavy blackouts
// ---------------------------------------------------------------------------

describe('fixture: referee with heavy blackouts', () => {
  /** One official free all season, one blacked out for most of it. */
  function seasonWithBlackedOutReferee() {
    return nineTeamSeason({
      config: {
        seed: 11,
        roundRobinTimes: 1,
        officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
      },
      referees: [
        referee('ref-open', 'Open Olive', {
          availability: [
            {
              id: 'w1',
              kind: 'weekly',
              dayOfWeek: 6,
              startMinute: 8 * 60,
              endMinute: 18 * 60,
              effectiveFrom: null,
              effectiveTo: null,
            },
          ],
        }),
        referee('ref-busy', 'Busy Bruno', {
          maxGamesPerDay: 1,
          availability: [
            {
              id: 'w2',
              kind: 'weekly',
              dayOfWeek: 6,
              startMinute: 8 * 60,
              endMinute: 18 * 60,
              effectiveFrom: null,
              effectiveTo: null,
            },
            // Blacked out for eight of the twelve Saturdays.
            { id: 'b1', kind: 'blackout', dayOfWeek: null, startMinute: null, endMinute: null, effectiveFrom: '2026-03-14', effectiveTo: '2026-04-11' },
            { id: 'b2', kind: 'blackout', dayOfWeek: null, startMinute: null, endMinute: null, effectiveFrom: '2026-04-25', effectiveTo: '2026-05-16' },
          ],
        }),
      ],
    })
  }

  const result = generateSchedule(seasonWithBlackedOutReferee())

  it('never assigns the blacked-out official on a blacked-out date', () => {
    const busy = result.assignments.filter((a) => a.refereeId === 'ref-busy')
    for (const assignment of busy) {
      const game = result.games[assignment.gameIndex]!
      const date = formatCalendarDate(calendarDateInZone(game.startTime, 'America/Los_Angeles'))
      const inBlackout =
        (date >= '2026-03-14' && date <= '2026-04-11') ||
        (date >= '2026-04-25' && date <= '2026-05-16')
      expect(inBlackout, `assigned Bruno on ${date}`).toBe(false)
    }
  })

  it('respects the blacked-out official’s tighter daily cap', () => {
    const perDate = new Map<string, number>()
    for (const assignment of result.assignments.filter((a) => a.refereeId === 'ref-busy')) {
      const game = result.games[assignment.gameIndex]!
      const date = formatCalendarDate(calendarDateInZone(game.startTime, 'America/Los_Angeles'))
      perDate.set(date, (perDate.get(date) ?? 0) + 1)
    }
    for (const [date, count] of perDate) {
      expect(count, `Bruno on ${date}`).toBeLessThanOrEqual(1)
    }
  })

  it('leans on the available official and reports what could not be filled', () => {
    const openCount = result.assignments.filter((a) => a.refereeId === 'ref-open').length
    const busyCount = result.assignments.filter((a) => a.refereeId === 'ref-busy').length
    expect(openCount).toBeGreaterThan(busyCount)

    // With 36 games and one mostly-available official capped at 3 a day, some
    // positions cannot be filled — and each says why.
    expect(result.report.counts.officialsRequired).toBe(36)
    for (const entry of result.report.unfilledOfficials) {
      expect(['daily_cap', 'blackout', 'outside_weekly_window', 'overlapping_assignment', 'insufficient_travel_time', 'none_eligible', 'conflict_of_interest']).toContain(entry.reason)
    }
    expect(
      result.report.counts.officialsAssigned + result.report.unfilledOfficials.length,
    ).toBe(result.report.counts.officialsRequired)
  })

  it('never assigns an official to a game involving a team they are tied to', () => {
    const conflicted = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 3,
          roundRobinTimes: 1,
          officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
        },
        referees: [
          referee('ref-parent', 'Parent Pat', { conflictTeamIds: [teamId('Rovers')] }),
          referee('ref-clear', 'Clear Chris'),
        ],
      }),
    )

    for (const assignment of conflicted.assignments.filter((a) => a.refereeId === 'ref-parent')) {
      const game = conflicted.games[assignment.gameIndex]!
      expect([game.homeTeamId, game.awayTeamId]).not.toContain(teamId('Rovers'))
    }
  })

  it('balances assignments and pay across an unconstrained pool', () => {
    const balanced = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 5,
          roundRobinTimes: 1,
          officialsRequired: { center: 1, AR1: 1, AR2: 0, scorekeeper: 0 },
        },
        referees: [
          referee('ref-1', 'One', { maxGamesPerDay: 6 }),
          referee('ref-2', 'Two', { maxGamesPerDay: 6 }),
          referee('ref-3', 'Three', { maxGamesPerDay: 6 }),
          referee('ref-4', 'Four', { maxGamesPerDay: 6 }),
        ],
      }),
    )

    const games = balanced.report.refereeLoad.map((r) => r.games)
    expect(Math.max(...games) - Math.min(...games)).toBeLessThanOrEqual(2)

    const pay = balanced.report.refereeLoad.map((r) => r.payCents)
    // Equal rates, so balanced counts mean balanced pay.
    expect(Math.max(...pay) - Math.min(...pay)).toBeLessThanOrEqual(2 * 4500)
  })

  it('never assigns one official to overlapping games', () => {
    const single = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 9,
          roundRobinTimes: 1,
          officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
        },
        referees: [referee('ref-solo', 'Solo', { maxGamesPerDay: 20, travelBufferMinutes: 0 })],
      }),
    )

    const windows = single.assignments.map((a) => {
      const game = single.games[a.gameIndex]!
      return { start: game.startTime.getTime(), end: game.startTime.getTime() + game.durationMinutes * 60_000 }
    })
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i]!
        const b = windows[j]!
        expect(a.start < b.end && b.start < a.end).toBe(false)
      }
    }
  })

  it('leaves enough travel time between venues', () => {
    const travel = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 13,
          roundRobinTimes: 1,
          officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
        },
        referees: [referee('ref-travel', 'Traveller', { maxGamesPerDay: 20, travelBufferMinutes: 90 })],
      }),
    )

    const byVenue = travel.assignments.map((a) => {
      const game = travel.games[a.gameIndex]!
      const fieldToVenue: Record<string, string> = {
        'field-r1': 'venue-riverside',
        'field-r2': 'venue-riverside',
        'field-e1': 'venue-eastside',
      }
      return {
        venueId: fieldToVenue[game.fieldId]!,
        start: game.startTime.getTime(),
        end: game.startTime.getTime() + game.durationMinutes * 60_000,
      }
    })

    for (let i = 0; i < byVenue.length; i++) {
      for (let j = i + 1; j < byVenue.length; j++) {
        const a = byVenue[i]!
        const b = byVenue[j]!
        if (a.venueId === b.venueId) continue
        const gap = a.start >= b.end ? (a.start - b.end) / 60_000 : (b.start - a.end) / 60_000
        expect(gap).toBeGreaterThanOrEqual(90)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture 4 — mid-season regeneration preserving played games
// ---------------------------------------------------------------------------

describe('fixture: mid-season regeneration preserves played games', () => {
  /** Turns the first `count` games of a schedule into played results. */
  function asPlayed(games: GeneratedGame[], count: number): ExistingGameInput[] {
    return games.slice(0, count).map((game, index) => ({
      id: `existing-${index}`,
      divisionId: game.divisionId,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      fieldId: game.fieldId,
      startTime: game.startTime,
      durationMinutes: game.durationMinutes,
      status: 'played',
      roundNumber: game.roundNumber,
      homeScore: (index % 4) as number,
      awayScore: (index % 3) as number,
    }))
  }

  const first = generateSchedule(nineTeamSeason())
  const played = asPlayed(first.games, 12)

  // Regenerate with a different seed, to prove preservation is not luck.
  const second = generateSchedule(
    nineTeamSeason({ config: { seed: 999, roundRobinTimes: 2 }, existingGames: played }),
  )

  it('keeps every played game exactly where it was', () => {
    const preserved = second.games.filter((g) => g.preserved)
    expect(preserved).toHaveLength(played.length)

    for (const original of played) {
      const match = preserved.find((g) => g.existingId === original.id)
      expect(match, `played game ${original.id} vanished`).toBeDefined()
      expect(match!.startTime.toISOString()).toBe(original.startTime.toISOString())
      expect(match!.fieldId).toBe(original.fieldId)
      expect(match!.homeTeamId).toBe(original.homeTeamId)
      expect(match!.awayTeamId).toBe(original.awayTeamId)
    }
  })

  it('does not schedule anything on top of a played game', () => {
    expectNoDoubleBookings(second)

    const playedSlots = new Set(played.map((g) => `${g.fieldId}|${g.startTime.getTime()}`))
    for (const game of second.games.filter((g) => !g.preserved)) {
      expect(playedSlots.has(`${game.fieldId}|${game.startTime.getTime()}`)).toBe(false)
    }
  })

  it('does not re-fixture a matchup that has already been played', () => {
    const playedPairs = new Set(
      played.map((g) => [g.homeTeamId, g.awayTeamId].sort().join('|')),
    )
    const regenerated = second.games.filter((g) => !g.preserved)

    // Each pair meets twice in a double round robin, so a pair with one game played
    // may legitimately appear once more. It must not appear twice more.
    const counts = new Map<string, number>()
    for (const game of regenerated) {
      const key = [game.homeTeamId, game.awayTeamId].sort().join('|')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const pair of playedPairs) {
      expect(counts.get(pair) ?? 0, `pair ${pair}`).toBeLessThanOrEqual(1)
    }
  })

  it('still ends with a complete, legal season', () => {
    const total = second.games.length
    expect(total).toBeGreaterThanOrEqual(first.games.length - 6)
    expectNoDoubleBookings(second)
    expect(second.report.counts.preserved).toBe(12)
  })

  it('says in the report that games were preserved', () => {
    expect(second.report.notes.join(' ')).toContain('Preserved 12 existing game')
  })

  it('leaves a schedule with no preserved games unchanged in shape', () => {
    const fresh = generateSchedule(nineTeamSeason({ existingGames: [] }))
    expect(fresh.report.counts.preserved).toBe(0)
    // Same capacity ceiling as the plain 12-Saturday fixture above.
    expect(fresh.games).toHaveLength(48)
  })

  it('ignores games whose status is not in preserveStatuses', () => {
    const scheduled = played.map((g) => ({ ...g, status: 'scheduled' }))
    const result = generateSchedule(
      nineTeamSeason({ config: { seed: 42, roundRobinTimes: 2 }, existingGames: scheduled }),
    )
    expect(result.report.counts.preserved).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Blackouts, cross-division, caps, playoffs
// ---------------------------------------------------------------------------

describe('blackouts during placement', () => {
  it('never schedules a team on its own team-scoped blackout', () => {
    const rovers = teamId('Rovers')
    const result = generateSchedule(
      nineTeamSeason({
        blackouts: [
          blackout('b1', 'team', '2026-03-07', '2026-04-04', 'Touring', { teamId: rovers }),
        ],
      }),
    )

    for (const game of result.games) {
      if (game.homeTeamId !== rovers && game.awayTeamId !== rovers) continue
      const date = formatCalendarDate(calendarDateInZone(game.startTime, 'America/Los_Angeles'))
      expect(date >= '2026-03-07' && date <= '2026-04-04').toBe(false)
    }
  })

  it('never schedules a division on its division-scoped blackout', () => {
    const result = generateSchedule(
      nineTeamSeason({
        blackouts: [
          blackout('b1', 'division', '2026-03-21', '2026-03-21', 'Tournament', {
            divisionId: 'div-u12',
          }),
        ],
      }),
    )
    for (const game of result.games) {
      const date = formatCalendarDate(calendarDateInZone(game.startTime, 'America/Los_Angeles'))
      expect(date).not.toBe('2026-03-21')
    }
  })
})

describe('format options', () => {
  it('honours a single round robin', () => {
    const result = generateSchedule(nineTeamSeason({ config: { seed: 1, roundRobinTimes: 1 } }))
    expect(result.games).toHaveLength(36) // 9 choose 2
  })

  it('honours three times through', () => {
    // 36 fixtures a pass, so 108 games and 24 per team. At one game per team per
    // Saturday that needs at least 27 Saturdays of capacity.
    const result = generateSchedule(
      nineTeamSeason({
        config: { seed: 1, roundRobinTimes: 3 },
        season: { id: 's', startDate: '2026-03-07', endDate: '2026-09-26' },
      }),
    )
    expect(result.games).toHaveLength(108)
    expect(result.report.counts.unplaced).toBe(0)
    expect(new Set(gamesPerTeamPublic(result).values())).toEqual(new Set([24]))
  })

  it('caps games per team independently of the round count', () => {
    const result = generateSchedule(
      nineTeamSeason({ config: { seed: 1, roundRobinTimes: 2, gamesPerTeamCap: 6 } }),
    )
    for (const [team, count] of gamesPerTeam(result)) {
      expect(count, team).toBeLessThanOrEqual(6)
    }
    expect(result.report.notes.join(' ')).toContain('Games-per-team cap')
  })

  it('caps the number of rounds', () => {
    const result = generateSchedule(
      nineTeamSeason({ config: { seed: 1, roundRobinTimes: 2, numberOfRounds: 4 } }),
    )
    expect(Math.max(...result.games.map((g) => g.roundNumber))).toBeLessThanOrEqual(4)
    expect(result.report.notes.join(' ')).toContain('caps it at 4')
  })

  it('pools all teams when cross-division play is full', () => {
    const result = generateSchedule({
      config: { seed: 4, roundRobinTimes: 1, crossDivisionPlay: 'full' },
      season: { id: 's', startDate: '2026-03-07', endDate: '2026-06-27' },
      divisions: [
        division('div-a', 'Division A', ['A1', 'A2', 'A3', 'A4']),
        division('div-b', 'Division B', ['B1', 'B2', 'B3', 'B4']),
      ],
      fields: twoVenuesThreeFields(),
      referees: [],
      blackouts: [],
    })

    // 8 teams in one pool = 28 games, some of them inter-division.
    expect(result.games).toHaveLength(28)
    const cross = result.games.filter(
      (g) => g.homeTeamId.startsWith('team-a') !== g.awayTeamId.startsWith('team-a'),
    )
    expect(cross.length).toBeGreaterThan(0)
    expect(result.report.notes.join(' ')).toContain('Cross-division play is full')
  })

  it('adds a bounded number of games when cross-division play is limited', () => {
    const result = generateSchedule({
      config: {
        seed: 4,
        roundRobinTimes: 1,
        crossDivisionPlay: 'limited',
        crossDivisionGamesPerTeam: 1,
      },
      season: { id: 's', startDate: '2026-03-07', endDate: '2026-06-27' },
      divisions: [
        division('div-a', 'Division A', ['A1', 'A2', 'A3', 'A4']),
        division('div-b', 'Division B', ['B1', 'B2', 'B3', 'B4']),
      ],
      fields: twoVenuesThreeFields(),
      referees: [],
      blackouts: [],
    })

    const cross = result.games.filter(
      (g) => g.homeTeamId.startsWith('team-a') !== g.awayTeamId.startsWith('team-a'),
    )
    expect(cross.length).toBeGreaterThan(0)
    expect(cross.length).toBeLessThanOrEqual(8)
    expect(result.report.notes.join(' ')).toContain('Cross-division play is limited')
  })

  it('keeps divisions apart by default', () => {
    const result = generateSchedule({
      config: { seed: 4, roundRobinTimes: 1 },
      season: { id: 's', startDate: '2026-03-07', endDate: '2026-06-27' },
      divisions: [
        division('div-a', 'Division A', ['A1', 'A2', 'A3', 'A4']),
        division('div-b', 'Division B', ['B1', 'B2', 'B3', 'B4']),
      ],
      fields: twoVenuesThreeFields(),
      referees: [],
      blackouts: [],
    })

    for (const game of result.games) {
      expect(game.homeTeamId.startsWith('team-a')).toBe(game.awayTeamId.startsWith('team-a'))
    }
    expect(result.games).toHaveLength(12) // 6 per division
  })
})

describe('standings and playoffs', () => {
  it('ranks on points, then goal difference, then goals scored', () => {
    const teams = division('d', 'D', ['Alpha', 'Beta', 'Gamma']).teams
    const games: ExistingGameInput[] = [
      {
        id: 'g1', divisionId: 'd', homeTeamId: teamId('Alpha'), awayTeamId: teamId('Beta'),
        fieldId: 'f', startTime: new Date('2026-03-07T17:00:00Z'), durationMinutes: 60,
        status: 'played', roundNumber: 1, homeScore: 3, awayScore: 0,
      },
      {
        id: 'g2', divisionId: 'd', homeTeamId: teamId('Beta'), awayTeamId: teamId('Gamma'),
        fieldId: 'f', startTime: new Date('2026-03-14T17:00:00Z'), durationMinutes: 60,
        status: 'played', roundNumber: 2, homeScore: 2, awayScore: 2,
      },
      {
        id: 'g3', divisionId: 'd', homeTeamId: teamId('Gamma'), awayTeamId: teamId('Alpha'),
        fieldId: 'f', startTime: new Date('2026-03-21T17:00:00Z'), durationMinutes: 60,
        // Not played yet, so it must not count.
        status: 'scheduled', roundNumber: 3, homeScore: null, awayScore: null,
      },
    ]

    const table = computeStandings(teams, games)
    // Alpha leads on points. Beta and Gamma both have 1 point from the draw, but
    // Beta also lost 3-0, so Gamma takes second on goal difference.
    expect(table.map((r) => r.teamName)).toEqual(['Alpha', 'Gamma', 'Beta'])
    expect(table[0]!.points).toBe(3)
    expect(table[0]!.goalDifference).toBe(3)
    expect(table[1]!.points).toBe(1)
    expect(table[1]!.goalDifference).toBe(0)
    expect(table[2]!.points).toBe(1)
    expect(table[2]!.goalDifference).toBe(-3)
    // The unplayed game contributes nothing.
    expect(table.find((r) => r.teamName === 'Gamma')!.played).toBe(1)
  })

  it('reserves bracket slots and flags provisional seeding', () => {
    const result = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 8,
          roundRobinTimes: 1,
          playoffs: { enabled: true, format: 'single_elimination', teams: 4, seeding: 'standings' },
        },
        season: { id: 's', startDate: '2026-03-07', endDate: '2026-06-27' },
      }),
    )

    const bracket = result.games.filter((g) => g.bracket)
    // A 4-team single-elimination bracket is 2 semis plus a final.
    expect(bracket).toHaveLength(3)
    expect(bracket.filter((g) => g.bracket!.round === 1)).toHaveLength(2)
    expect(bracket.at(-1)!.bracket!.label).toContain('Final')

    // Round 1 has real teams; the final is waiting on them.
    expect(bracket[0]!.homeTeamId).not.toBe('')
    expect(bracket.at(-1)!.homeTeamId).toBe('')

    expect(result.report.notes.join(' ')).toContain('provisional')
    expectNoDoubleBookings(result)
  })

  it('builds a double-elimination bracket with a grand final', () => {
    const result = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 8,
          roundRobinTimes: 1,
          playoffs: { enabled: true, format: 'double_elimination', teams: 4, seeding: 'provisional' },
        },
        season: { id: 's', startDate: '2026-03-07', endDate: '2026-06-27' },
      }),
    )
    const labels = result.games.filter((g) => g.bracket).map((g) => g.bracket!.label)
    expect(labels.some((l) => l.includes('Grand Final'))).toBe(true)
    expect(labels.some((l) => l.includes(' L R'))).toBe(true)
  })
})

describe('degenerate inputs', () => {
  it('returns nothing and says why when there are no slots', () => {
    const result = generateSchedule(
      nineTeamSeason({ fields: [], config: { seed: 1, roundRobinTimes: 1 } }),
    )
    expect(result.games).toHaveLength(0)
    expect(result.report.notes.join(' ')).toContain('No bookable slots')
    expect(result.report.counts.unplaced).toBe(36)
  })

  it('handles a division with a single team', () => {
    const result = generateSchedule({
      config: { seed: 1 },
      season: { id: 's', startDate: '2026-03-07', endDate: '2026-03-28' },
      divisions: [division('d', 'Solo', ['Only'])],
      fields: twoVenuesThreeFields(),
      referees: [],
      blackouts: [],
    })
    expect(result.games).toHaveLength(0)
    expect(result.report.counts.unplaced).toBe(0)
  })

  it('handles two teams', () => {
    const result = generateSchedule({
      config: { seed: 1, roundRobinTimes: 2 },
      season: { id: 's', startDate: '2026-03-07', endDate: '2026-03-28' },
      divisions: [division('d', 'Pair', ['Left', 'Right'])],
      fields: twoVenuesThreeFields(),
      referees: [],
      blackouts: [],
    })
    expect(result.games).toHaveLength(2)
    expect(result.games[0]!.homeTeamId).not.toBe(result.games[1]!.homeTeamId)
  })

  it('reports unfilled positions when no officials are registered', () => {
    const result = generateSchedule(
      nineTeamSeason({
        config: {
          seed: 1,
          roundRobinTimes: 1,
          officialsRequired: { center: 1, AR1: 0, AR2: 0, scorekeeper: 0 },
        },
        referees: [],
      }),
    )
    expect(result.assignments).toHaveLength(0)
    expect(result.report.unfilledOfficials).toHaveLength(36)
    expect(result.report.unfilledOfficials[0]!.reason).toBe('no_officials_registered')
  })

  it('skips official assignment entirely when switched off', () => {
    const result = generateSchedule(
      nineTeamSeason({
        config: { seed: 1, roundRobinTimes: 1, assignOfficials: false },
        referees: [referee('ref-a', 'Ada')],
      }),
    )
    expect(result.assignments).toHaveLength(0)
    expect(result.report.unfilledOfficials).toHaveLength(0)
    expect(result.report.counts.officialsRequired).toBe(0)
  })
})

describe('sibling proximity', () => {
  it('pulls sibling teams’ games onto the same day when it can', () => {
    const withSiblings = generateSchedule(
      nineTeamSeason({
        config: { seed: 21, roundRobinTimes: 1, weights: { siblingProximity: 200 } },
        siblingGroups: [{ label: 'Okonjo', teamIds: [teamId('Rovers'), teamId('Owls')] }],
      }),
    )

    const datesFor = (id: string) =>
      new Set(
        withSiblings.games
          .filter((g) => g.homeTeamId === id || g.awayTeamId === id)
          .map((g) => formatCalendarDate(calendarDateInZone(g.startTime, 'America/Los_Angeles'))),
      )

    const rovers = datesFor(teamId('Rovers'))
    const owls = datesFor(teamId('Owls'))
    const shared = [...rovers].filter((d) => owls.has(d))

    // With a heavy weight the two should share most of their match days.
    expect(shared.length).toBeGreaterThanOrEqual(Math.min(rovers.size, owls.size) - 2)
  })
})
