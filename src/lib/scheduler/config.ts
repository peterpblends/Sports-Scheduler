import { z } from 'zod'
import type { ScheduleConfig, ScheduleConfigInput } from './types'

/**
 * Defaults for every scheduling parameter, chosen for the common case: a weekend
 * youth league playing a double round robin on Saturdays with a three-official crew.
 *
 * Callers may pass `{}` and get a working schedule; the UI exposes all of these.
 */
export const DEFAULT_CONFIG: ScheduleConfig = {
  seed: 1,

  roundRobinTimes: 2,
  gamesPerTeamCap: null,
  numberOfRounds: null,
  byeHandling: 'balanced',
  crossDivisionPlay: 'none',
  crossDivisionGamesPerTeam: 2,

  playableDaysOfWeek: [6],
  gameDurationMinutes: 60,
  bufferMinutes: 15,
  earliestStartMinute: 8 * 60,
  latestStartMinute: 17 * 60,
  dayWindows: [],
  minRestDays: 3,
  maxGamesPerTeamPerDay: 1,
  maxGamesPerTeamPerWeek: 2,

  homeAwayBalanceTarget: 1,
  weights: {
    homeAway: 12,
    consecutiveOpponent: 8,
    slotRotation: 4,
    venueSpread: 3,
    restDays: 20,
    siblingProximity: 6,
    preferredVenue: 2,
    targetRound: 40,
  },

  officialsRequired: { center: 1, AR1: 1, AR2: 1, scorekeeper: 0 },
  assignOfficials: true,

  playoffs: {
    enabled: false,
    format: 'single_elimination',
    teams: 4,
    seeding: 'standings',
  },

  preserveStatuses: ['played'],
  maxBacktrackSteps: 20_000,
}

/** Fills defaults and normalizes anything order-dependent, so the result is stable. */
export function resolveConfig(input: ScheduleConfigInput = {}): ScheduleConfig {
  const config: ScheduleConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    weights: { ...DEFAULT_CONFIG.weights, ...(input.weights ?? {}) },
    officialsRequired: {
      ...DEFAULT_CONFIG.officialsRequired,
      ...(input.officialsRequired ?? {}),
    },
    playoffs: { ...DEFAULT_CONFIG.playoffs, ...(input.playoffs ?? {}) },
    // Sorted and de-duplicated: two configs that mean the same thing must produce
    // byte-identical schedules, which matters for the idempotence guarantee.
    playableDaysOfWeek: [...new Set(input.playableDaysOfWeek ?? DEFAULT_CONFIG.playableDaysOfWeek)]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b),
    dayWindows: [...(input.dayWindows ?? DEFAULT_CONFIG.dayWindows)].sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek,
    ),
    preserveStatuses: [...new Set(input.preserveStatuses ?? DEFAULT_CONFIG.preserveStatuses)].sort(),
  }

  if (config.playableDaysOfWeek.length === 0) {
    config.playableDaysOfWeek = [...DEFAULT_CONFIG.playableDaysOfWeek]
  }
  return config
}

/** The local-time kickoff window for a given day, honouring per-day overrides. */
export function windowForDay(
  config: ScheduleConfig,
  dayOfWeek: number,
): { earliest: number; latest: number } {
  const override = config.dayWindows.find((w) => w.dayOfWeek === dayOfWeek)
  return {
    earliest: override?.earliestStartMinute ?? config.earliestStartMinute,
    latest: override?.latestStartMinute ?? config.latestStartMinute,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const minute = z.number().int().min(0).max(24 * 60)

const weightsSchema = z
  .object({
    homeAway: z.number().min(0).max(1000),
    consecutiveOpponent: z.number().min(0).max(1000),
    slotRotation: z.number().min(0).max(1000),
    venueSpread: z.number().min(0).max(1000),
    restDays: z.number().min(0).max(1000),
    siblingProximity: z.number().min(0).max(1000),
    preferredVenue: z.number().min(0).max(1000),
    targetRound: z.number().min(0).max(1000),
  })
  .partial()

/**
 * Wire-format schema for the config. Every field optional — the UI sends only what
 * the admin changed, and `resolveConfig` supplies the rest.
 */
export const scheduleConfigSchema = z
  .object({
    seed: z.number().int().min(0).max(2 ** 31 - 1),

    roundRobinTimes: z.number().int().min(1).max(10),
    gamesPerTeamCap: z.number().int().min(1).max(200).nullable(),
    numberOfRounds: z.number().int().min(1).max(200).nullable(),
    byeHandling: z.enum(['balanced', 'rotate']),
    crossDivisionPlay: z.enum(['none', 'limited', 'full']),
    crossDivisionGamesPerTeam: z.number().int().min(0).max(50),

    playableDaysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    gameDurationMinutes: z.number().int().min(5).max(600),
    bufferMinutes: z.number().int().min(0).max(240),
    earliestStartMinute: minute,
    latestStartMinute: minute,
    dayWindows: z
      .array(
        z.object({
          dayOfWeek: z.number().int().min(0).max(6),
          earliestStartMinute: minute.optional(),
          latestStartMinute: minute.optional(),
        }),
      )
      .max(7),
    minRestDays: z.number().int().min(0).max(60),
    maxGamesPerTeamPerDay: z.number().int().min(1).max(10),
    maxGamesPerTeamPerWeek: z.number().int().min(1).max(20),

    homeAwayBalanceTarget: z.number().int().min(0).max(20),
    weights: weightsSchema,

    officialsRequired: z
      .object({
        center: z.number().int().min(0).max(4),
        AR1: z.number().int().min(0).max(4),
        AR2: z.number().int().min(0).max(4),
        scorekeeper: z.number().int().min(0).max(4),
      })
      .partial(),
    assignOfficials: z.boolean(),

    playoffs: z
      .object({
        enabled: z.boolean(),
        format: z.enum(['single_elimination', 'double_elimination']),
        teams: z.number().int().min(2).max(64),
        seeding: z.enum(['standings', 'provisional']),
      })
      .partial(),

    preserveStatuses: z.array(
      z.enum(['scheduled', 'confirmed', 'played', 'postponed', 'cancelled']),
    ),
    maxBacktrackSteps: z.number().int().min(0).max(500_000),
  })
  .partial()
  .refine((c) => (c.latestStartMinute ?? 0) >= (c.earliestStartMinute ?? 0), {
    message: 'The latest start time cannot be before the earliest.',
    path: ['latestStartMinute'],
  })
