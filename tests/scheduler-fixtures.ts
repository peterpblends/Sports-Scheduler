import type {
  BlackoutInput,
  DivisionInput,
  FieldInput,
  RefereeInput,
  SchedulerInput,
  TimeSlotInput,
} from '@/lib/scheduler'

/**
 * Fixtures for the engine tests.
 *
 * Deliberately plain objects: the engine never touches Prisma, so its tests never
 * touch a database. Ids are readable so a failure message says which team.
 */

export function teamsFor(divisionId: string, names: string[], preferredVenueId?: string) {
  return names.map((name) => ({
    id: `team-${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    divisionId,
    preferredVenueId: preferredVenueId ?? null,
  }))
}

export function division(id: string, name: string, teamNames: string[]): DivisionInput {
  return { id, name, teams: teamsFor(id, teamNames) }
}

export function saturdaySlot(
  overrides: Partial<TimeSlotInput> = {},
): TimeSlotInput {
  return {
    id: `slot-${overrides.dayOfWeek ?? 6}-${overrides.startMinute ?? 480}`,
    dayOfWeek: 6,
    specificDate: null,
    startMinute: 8 * 60,
    endMinute: 18 * 60,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  }
}

export function field(
  id: string,
  name: string,
  venueId: string,
  venueName: string,
  timeSlots: TimeSlotInput[],
  timezone = 'America/Los_Angeles',
): FieldInput {
  return { id, name, venueId, venueName, timezone, timeSlots }
}

/** Two venues, three fields between them — the shape acceptance scenario 2 asks for. */
export function twoVenuesThreeFields(): FieldInput[] {
  return [
    field('field-r1', 'Field 1', 'venue-riverside', 'Riverside Park', [saturdaySlot()]),
    field('field-r2', 'Field 2', 'venue-riverside', 'Riverside Park', [saturdaySlot()]),
    field('field-e1', 'Turf A', 'venue-eastside', 'Eastside Complex', [saturdaySlot()]),
  ]
}

export function referee(
  id: string,
  name: string,
  overrides: Partial<RefereeInput> = {},
): RefereeInput {
  return {
    id,
    personId: `person-${id}`,
    name,
    payRateCents: 4500,
    maxGamesPerDay: 3,
    travelBufferMinutes: 30,
    preferredVenueIds: [],
    availability: [],
    conflictTeamIds: [],
    ...overrides,
  }
}

export function blackout(
  id: string,
  scope: BlackoutInput['scope'],
  startDate: string,
  endDate: string,
  reason: string,
  target: Partial<Pick<BlackoutInput, 'divisionId' | 'teamId' | 'venueId'>> = {},
): BlackoutInput {
  return { id, scope, startDate, endDate, reason, ...target }
}

/**
 * Acceptance scenario 2: a 9-team division, 2 venues with 3 fields, a 12-week
 * Saturdays-only window, generating a double round robin.
 *
 * 2026-03-07 to 2026-05-23 is 12 Saturdays and straddles the US DST change on
 * March 8, so the fixture exercises the local-time slot logic too.
 */
export function nineTeamSeason(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  const div = division('div-u12', 'U12 Boys', [
    'Rovers',
    'Owls',
    'Breakers',
    'Falcons',
    'United',
    'Nomads',
    'Hawks',
    'Strikers',
    'Wolves',
  ])

  return {
    config: { seed: 42, roundRobinTimes: 2 },
    season: { id: 'season-spring', startDate: '2026-03-07', endDate: '2026-05-23' },
    divisions: [div],
    fields: twoVenuesThreeFields(),
    referees: [],
    blackouts: [],
    ...overrides,
  }
}

/** A single field with only two usable slots a week — capacity is the binding limit. */
export function tightSingleVenueSeason(
  overrides: Partial<SchedulerInput> = {},
): SchedulerInput {
  return {
    config: { seed: 7, roundRobinTimes: 1, assignOfficials: false },
    season: { id: 'season-tight', startDate: '2026-03-07', endDate: '2026-04-25' },
    divisions: [division('div-rec', 'Rec', ['Ants', 'Bees', 'Cranes', 'Doves', 'Eagles', 'Finches'])],
    fields: [
      field('field-only', 'The Pitch', 'venue-park', 'Community Park', [
        // 9am and 10:15am only: two 60-minute games with a 15-minute buffer.
        saturdaySlot({ id: 'slot-tight', startMinute: 9 * 60, endMinute: 11 * 60 + 15 }),
      ]),
    ],
    referees: [],
    blackouts: [],
    ...overrides,
  }
}

export function teamId(name: string): string {
  return `team-${name.toLowerCase().replace(/\W+/g, '-')}`
}
