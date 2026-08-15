/**
 * Scheduling engine types.
 *
 * Everything here is plain data — no Prisma types, no Date.now(), no I/O. The
 * engine is a pure function of `SchedulerInput -> ScheduleResult`, so the whole
 * thing is unit-testable from fixtures with no database. `src/lib/scheduler/db.ts`
 * is the only place that knows about Prisma.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type CrossDivisionPlay = 'none' | 'limited' | 'full'
export type ByeHandling = 'balanced' | 'rotate'
export type PlayoffFormat = 'single_elimination' | 'double_elimination'
export type PlayoffSeeding = 'standings' | 'provisional'
export type OfficialPosition = 'center' | 'AR1' | 'AR2' | 'scorekeeper'

/** Per-day-of-week overrides for the earliest and latest kickoff, in local time. */
export type DayWindow = {
  /** 0 = Sunday. */
  dayOfWeek: number
  earliestStartMinute?: number
  latestStartMinute?: number
}

/**
 * Every knob the spec asks to expose in the UI. All optional on input, including the
 * fields inside the nested sections — the UI sends only what the admin changed, and
 * `resolveConfig` fills the rest.
 */
export type ScheduleConfigInput = Omit<
  Partial<ScheduleConfig>,
  'weights' | 'officialsRequired' | 'playoffs'
> & {
  weights?: Partial<ScheduleConfig['weights']>
  officialsRequired?: Partial<ScheduleConfig['officialsRequired']>
  playoffs?: Partial<ScheduleConfig['playoffs']>
}

export type ScheduleConfig = {
  /** Same seed + same config + same entities = same schedule. */
  seed: number

  // --- format
  /** Times through the round robin: 1 single, 2 double, N for N. */
  roundRobinTimes: number
  /** Hard cap on games per team, independent of round count. Null for no cap. */
  gamesPerTeamCap: number | null
  /** Rounds to schedule. Null derives it from the round robin and the date range. */
  numberOfRounds: number | null
  byeHandling: ByeHandling
  crossDivisionPlay: CrossDivisionPlay
  /** Only used when crossDivisionPlay is 'limited'. */
  crossDivisionGamesPerTeam: number

  // --- timing
  /** 0 = Sunday. Dates outside these days are never used. */
  playableDaysOfWeek: number[]
  gameDurationMinutes: number
  /** Clearance required between two games on the same field. */
  bufferMinutes: number
  /** Local-time bounds on kickoff, with optional per-day overrides. */
  earliestStartMinute: number
  latestStartMinute: number
  dayWindows: DayWindow[]
  /** Soft: reported when relaxed. */
  minRestDays: number
  /** Hard caps. */
  maxGamesPerTeamPerDay: number
  maxGamesPerTeamPerWeek: number

  // --- fairness (all soft; weights scale their influence on placement)
  /** Acceptable |home - away| per team before it counts as relaxed. */
  homeAwayBalanceTarget: number
  weights: {
    homeAway: number
    consecutiveOpponent: number
    slotRotation: number
    venueSpread: number
    restDays: number
    siblingProximity: number
    preferredVenue: number
    targetRound: number
  }

  // --- officials
  officialsRequired: Record<OfficialPosition, number>
  /** Skip official assignment entirely. */
  assignOfficials: boolean

  // --- playoffs
  playoffs: {
    enabled: boolean
    format: PlayoffFormat
    /** Teams qualifying per division. Rounded down to a power of two for the bracket. */
    teams: number
    seeding: PlayoffSeeding
  }

  // --- regeneration
  /** Game statuses that a regeneration must keep untouched. */
  preserveStatuses: string[]
  /** Bound on backtracking work, so generation always terminates. */
  maxBacktrackSteps: number
}

// ---------------------------------------------------------------------------
// Entity inputs
// ---------------------------------------------------------------------------

export type TeamInput = {
  id: string
  name: string
  divisionId: string
  preferredVenueId?: string | null
}

export type DivisionInput = {
  id: string
  name: string
  teams: TeamInput[]
}

/** A recurring or one-off window during which a field may be used. */
export type TimeSlotInput = {
  id: string
  /** 0 = Sunday. Null for a one-off slot. */
  dayOfWeek: number | null
  /** `YYYY-MM-DD` for a one-off slot, else null. */
  specificDate: string | null
  /** Minutes from local midnight. */
  startMinute: number
  endMinute: number
  effectiveFrom: string | null
  effectiveTo: string | null
}

export type FieldInput = {
  id: string
  name: string
  venueId: string
  venueName: string
  /** IANA zone. Slot minutes are interpreted in this zone. */
  timezone: string
  timeSlots: TimeSlotInput[]
}

export type RefereeAvailabilityInput = {
  id: string
  kind: 'weekly' | 'blackout'
  dayOfWeek: number | null
  startMinute: number | null
  endMinute: number | null
  /** Calendar dates. For a blackout these bound the unavailable range inclusively. */
  effectiveFrom: string | null
  effectiveTo: string | null
}

export type RefereeInput = {
  id: string
  personId: string
  name: string
  payRateCents: number | null
  maxGamesPerDay: number
  travelBufferMinutes: number
  preferredVenueIds: string[]
  availability: RefereeAvailabilityInput[]
  /** Teams this official is on the roster of, or related to someone on. */
  conflictTeamIds: string[]
}

export type BlackoutInput = {
  id: string
  scope: 'org' | 'division' | 'team' | 'venue'
  divisionId?: string | null
  teamId?: string | null
  venueId?: string | null
  /** Inclusive calendar dates. */
  startDate: string
  endDate: string
  reason: string
}

/** An already-persisted game, supplied so a regeneration can respect it. */
export type ExistingGameInput = {
  id: string
  divisionId: string
  homeTeamId: string
  awayTeamId: string
  fieldId: string | null
  /** UTC instant. */
  startTime: Date
  durationMinutes: number
  status: string
  roundNumber: number | null
  homeScore?: number | null
  awayScore?: number | null
}

/** Teams whose games should be kept close together — siblings in one family. */
export type SiblingGroupInput = {
  label: string
  teamIds: string[]
}

export type SchedulerInput = {
  config: ScheduleConfigInput
  season: {
    id: string
    /** Inclusive calendar dates, `YYYY-MM-DD`. */
    startDate: string
    endDate: string
  }
  divisions: DivisionInput[]
  fields: FieldInput[]
  referees: RefereeInput[]
  blackouts: BlackoutInput[]
  existingGames?: ExistingGameInput[]
  siblingGroups?: SiblingGroupInput[]
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type GeneratedGame = {
  /** Set only for a preserved existing game; new games have no id yet. */
  existingId: string | null
  divisionId: string
  homeTeamId: string
  awayTeamId: string
  fieldId: string
  /** UTC instant. */
  startTime: Date
  durationMinutes: number
  roundNumber: number
  /** True when this game came in via `existingGames` and was left alone. */
  preserved: boolean
  /** Set for playoff games. */
  bracket?: { round: number; matchIndex: number; label: string }
}

export type GeneratedAssignment = {
  /** Index into `games`. Games are not persisted yet, so referencing by index. */
  gameIndex: number
  refereeId: string
  position: OfficialPosition
  payCents: number
}

export type ByeRecord = { divisionId: string; teamId: string; roundNumber: number }

export type UnplacedGame = {
  divisionId: string
  homeTeamId: string
  awayTeamId: string
  roundNumber: number
  reason: string
}

export type UnfilledPosition = {
  gameIndex: number
  position: OfficialPosition
  reason: string
}

export type SoftConstraintReport = {
  /** Stable key, e.g. `home_away_balance`. */
  constraint: string
  /** What the config asked for, in words. */
  target: string
  relaxed: boolean
  /** How far past the target, in the constraint's own units. 0 when met. */
  magnitude: number
  unit: string
  affected: Array<{ teamId: string; teamName: string; detail: string; magnitude: number }>
}

export type TeamSummary = {
  teamId: string
  teamName: string
  divisionId: string
  games: number
  home: number
  away: number
  homeAwayDelta: number
  byes: number
  /** Count of games per venue, so travel spread is visible. */
  venueCounts: Record<string, number>
  /** Count of games per time-of-day bucket. */
  slotBuckets: Record<SlotBucket, number>
  /** Smallest gap between two of this team's games, in days. Null with under 2 games. */
  minRestDaysObserved: number | null
  /** Rounds where this team met the same opponent as the round before. */
  consecutiveOpponentRounds: number[]
}

export type SlotBucket = 'early' | 'midday' | 'late'

export type RefereeLoad = {
  refereeId: string
  name: string
  games: number
  payCents: number
}

export type ScheduleReport = {
  seed: number
  /** Rounds the engine actually scheduled. */
  rounds: number
  counts: {
    placed: number
    preserved: number
    unplaced: number
    byes: number
    officialsRequired: number
    officialsAssigned: number
  }
  teams: TeamSummary[]
  softConstraints: SoftConstraintReport[]
  unplaced: UnplacedGame[]
  unfilledOfficials: UnfilledPosition[]
  refereeLoad: RefereeLoad[]
  /** Human-readable notes: derived round counts, provisional seeding, and so on. */
  notes: string[]
}

export type ScheduleResult = {
  config: ScheduleConfig
  games: GeneratedGame[]
  assignments: GeneratedAssignment[]
  byes: ByeRecord[]
  report: ScheduleReport
}
