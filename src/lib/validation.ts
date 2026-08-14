import { z } from 'zod'
import { ROLES } from './authz'

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address.')
  .transform((v) => v.toLowerCase())

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'That password is too long.')

export const nameSchema = z.string().trim().min(1, 'Required.').max(120)

export const roleSchema = z.enum(ROLES)

/** Roles an invitation may grant. Ownership transfers are a separate action. */
export const invitableRoleSchema = z.enum(['admin', 'scheduler', 'coach', 'referee', 'viewer'])

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidTimezone, 'Unknown IANA time zone.')

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const signupSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
})

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Required.'),
})

export const forgotPasswordSchema = z.object({ email: emailSchema })

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
})

export const createOrgSchema = z.object({
  name: nameSchema,
  timezone: timezoneSchema.default('America/Los_Angeles'),
})

export const inviteSchema = z.object({
  email: emailSchema,
  role: invitableRoleSchema,
})

export const updateRoleSchema = z.object({ role: roleSchema })

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  // Only used when the invitee does not have an account yet.
  name: nameSchema.optional(),
  password: passwordSchema.optional(),
})

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'org'
  )
}

// ---------------------------------------------------------------------------
// Phase 2 — core entities
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`. Parsed to UTC midnight so a calendar date never shifts zone. */
export const calendarDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(parseCalendarDateSafe(v)?.getTime()), 'Not a real date.')

/** `HH:MM`, 24-hour, converted to minutes from local midnight. */
export const timeOfDaySchema = z
  .string()
  .trim()
  .regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM (24-hour).')
  .refine((v) => {
    const [h, m] = v.split(':').map(Number)
    return h! <= 23 && m! <= 59
  }, 'Not a real time.')
  .transform((v) => {
    const [h, m] = v.split(':').map(Number)
    return h! * 60 + m!
  })

function parseCalendarDateSafe(input: string): Date | null {
  const [y, m, d] = input.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  return date.getUTCMonth() === m! - 1 && date.getUTCDate() === d! ? date : null
}

export const dayOfWeekSchema = z.number().int().min(0).max(6)
export const optionalText = z.string().trim().max(2000).nullish()
const shortText = z.string().trim().max(200).nullish()

/** Hex colour like #1a2b3c, or null to clear. */
export const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1b7f3a.')
  .nullish()

const urlSchema = z.string().trim().url('Enter a valid URL.').max(500).nullish()

/**
 * A date range where the end must not precede the start. Both bounds may be
 * absent or explicitly null, in which case there is nothing to compare.
 * String comparison is correct here because the inputs are zero-padded ISO dates.
 */
function dateRange<T extends { startDate?: string | null; endDate?: string | null }>(
  schema: z.ZodType<T>,
) {
  return schema.refine((v) => !v.startDate || !v.endDate || v.startDate <= v.endDate, {
    message: 'The end date cannot be before the start date.',
    path: ['endDate'],
  })
}

// League ---------------------------------------------------------------------

export const createLeagueSchema = z.object({
  name: nameSchema,
  sport: z.string().trim().min(1).max(60).default('soccer'),
  description: optionalText,
})

export const updateLeagueSchema = createLeagueSchema.partial()

// Season ---------------------------------------------------------------------

export const seasonStatusSchema = z.enum(['draft', 'active', 'archived'])

export const createSeasonSchema = dateRange(
  z.object({
    leagueId: z.string().min(1),
    name: nameSchema,
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    status: seasonStatusSchema.default('draft'),
  }),
)

export const updateSeasonSchema = dateRange(
  z.object({
    name: nameSchema.optional(),
    startDate: calendarDateSchema.optional(),
    endDate: calendarDateSchema.optional(),
    status: seasonStatusSchema.optional(),
  }),
)

// Division -------------------------------------------------------------------

export const createDivisionSchema = z.object({
  seasonId: z.string().min(1),
  name: nameSchema,
  description: optionalText,
})

export const updateDivisionSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText,
})

// Team -----------------------------------------------------------------------

export const createTeamSchema = z.object({
  divisionId: z.string().min(1),
  name: nameSchema,
  primaryColor: colorSchema,
  secondaryColor: colorSchema,
  logoUrl: urlSchema,
  preferredVenueId: z.string().min(1).nullish(),
  contactName: shortText,
  contactEmail: emailSchema.nullish(),
  contactPhone: shortText,
})

export const updateTeamSchema = createTeamSchema.omit({ divisionId: true }).partial()

// Person ---------------------------------------------------------------------

export const createPersonSchema = z.object({
  name: nameSchema,
  email: emailSchema.nullish(),
  phone: shortText,
  dob: calendarDateSchema.nullish(),
  notes: optionalText,
  hasConflictOfInterest: z.boolean().default(false),
  conflictNote: optionalText,
  /// Links this person to an existing user account in the org.
  userId: z.string().min(1).nullish(),
})

export const updatePersonSchema = createPersonSchema.partial()

export const relationshipKindSchema = z.enum(['family', 'guardian', 'other'])

export const createRelationshipSchema = z.object({
  relatedPersonId: z.string().min(1),
  kind: relationshipKindSchema.default('family'),
})

// TeamMembership -------------------------------------------------------------

export const teamRoleSchema = z.enum(['player', 'coach', 'assistant', 'manager'])

export const createTeamMembershipSchema = dateRange(
  z.object({
    personId: z.string().min(1),
    role: teamRoleSchema.default('player'),
    jerseyNumber: z.string().trim().max(10).nullish(),
    startDate: calendarDateSchema.nullish(),
    endDate: calendarDateSchema.nullish(),
  }),
)

export const updateTeamMembershipSchema = dateRange(
  z.object({
    role: teamRoleSchema.optional(),
    jerseyNumber: z.string().trim().max(10).nullish(),
    startDate: calendarDateSchema.nullish(),
    endDate: calendarDateSchema.nullish(),
  }),
)

// Referee --------------------------------------------------------------------

export const createRefereeSchema = z.object({
  personId: z.string().min(1),
  certificationLevel: shortText,
  payRateCents: z.number().int().min(0).max(1_000_000).nullish(),
  maxGamesPerDay: z.number().int().min(1).max(20).default(3),
  travelBufferMinutes: z.number().int().min(0).max(600).default(30),
  preferredVenueIds: z.array(z.string().min(1)).max(100).default([]),
})

export const updateRefereeSchema = createRefereeSchema.omit({ personId: true }).partial()

export const createAvailabilitySchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('weekly'),
      dayOfWeek: dayOfWeekSchema,
      startTime: timeOfDaySchema,
      endTime: timeOfDaySchema,
      effectiveFrom: calendarDateSchema.nullish(),
      effectiveTo: calendarDateSchema.nullish(),
      reason: shortText,
    }),
    z.object({
      kind: z.literal('blackout'),
      startDate: calendarDateSchema,
      endDate: calendarDateSchema,
      reason: shortText,
    }),
  ])
  .refine(
    (v) => (v.kind === 'weekly' ? v.endTime > v.startTime : v.endDate >= v.startDate),
    'The end must come after the start.',
  )

// Venue, field, time slot ----------------------------------------------------

export const createVenueSchema = z.object({
  name: nameSchema,
  address: shortText,
  timezone: timezoneSchema,
  notes: optionalText,
})

export const updateVenueSchema = createVenueSchema.partial()

export const createFieldSchema = z.object({
  name: nameSchema,
  notes: optionalText,
})

export const updateFieldSchema = createFieldSchema.partial()

/**
 * A time slot is either recurring (a day of the week, optionally bounded by an
 * effective date range) or one-off (a single calendar date). The discriminator
 * keeps the two from being mixed into a meaningless row.
 */
export const createTimeSlotSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('recurring'),
      dayOfWeek: dayOfWeekSchema,
      startTime: timeOfDaySchema,
      endTime: timeOfDaySchema,
      effectiveFrom: calendarDateSchema.nullish(),
      effectiveTo: calendarDateSchema.nullish(),
      notes: optionalText,
    }),
    z.object({
      kind: z.literal('one_off'),
      specificDate: calendarDateSchema,
      startTime: timeOfDaySchema,
      endTime: timeOfDaySchema,
      notes: optionalText,
    }),
  ])
  .refine((v) => v.endTime > v.startTime, {
    message: 'The end time must be after the start time.',
    path: ['endTime'],
  })

// Game -----------------------------------------------------------------------

export const gameStatusSchema = z.enum([
  'scheduled',
  'confirmed',
  'played',
  'postponed',
  'cancelled',
])

export const createGameSchema = z.object({
  divisionId: z.string().min(1),
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  fieldId: z.string().min(1).nullish(),
  /// Absolute instant, ISO 8601 with an offset or Z.
  startTime: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(600).default(60),
  status: gameStatusSchema.default('scheduled'),
  roundNumber: z.number().int().min(0).max(1000).nullish(),
  notes: optionalText,
  /// Required when the placement knowingly breaks a hard constraint. Logged.
  overrideReason: z.string().trim().min(3).max(500).optional(),
})

export const updateGameSchema = z.object({
  fieldId: z.string().min(1).nullish(),
  startTime: z.string().datetime({ offset: true }).optional(),
  /**
   * A kickoff as a human typed it: the wall clock at the venue. The endpoint converts
   * it in the *target* field's zone, so moving a game between venues keeps the local
   * time the operator chose rather than the instant. Pass with `localTime`; ignored
   * when `startTime` is given, which is already an instant.
   */
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  localTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  durationMinutes: z.number().int().min(5).max(600).optional(),
  status: gameStatusSchema.optional(),
  homeScore: z.number().int().min(0).max(999).nullish(),
  awayScore: z.number().int().min(0).max(999).nullish(),
  roundNumber: z.number().int().min(0).max(1000).nullish(),
  notes: optionalText,
  /// Required when the change knowingly breaks a hard constraint. Logged.
  overrideReason: z.string().trim().min(3).max(500).optional(),
})

export const officialPositionSchema = z.enum(['center', 'AR1', 'AR2', 'scorekeeper'])
export const acceptanceStatusSchema = z.enum(['pending', 'accepted', 'declined'])

export const createGameOfficialSchema = z.object({
  refereeId: z.string().min(1),
  position: officialPositionSchema,
  payRateCentsOverride: z.number().int().min(0).max(1_000_000).nullish(),
  overrideReason: z.string().trim().min(3).max(500).optional(),
})

export const updateGameOfficialSchema = z.object({
  status: acceptanceStatusSchema.optional(),
  payRateCentsOverride: z.number().int().min(0).max(1_000_000).nullish(),
})

// Officiating requests -------------------------------------------------------

/**
 * Note the absence of `refereeId`. A referee requests for themselves and nobody
 * else; the identity comes from the session in `requireOwnRefereeRequest`. Adding
 * the field here — even validated — would be the whole vulnerability.
 */
export const createOfficiatingRequestSchema = z.object({
  position: officialPositionSchema,
  note: z.string().trim().max(500).optional(),
})

export const decideOfficiatingRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  decisionNote: z.string().trim().max(500).optional(),
  /**
   * An approval places the referee on the crew, so it is subject to the same hard
   * constraints as any assignment and the same override-with-reason escape.
   */
  overrideReason: z.string().trim().min(3).max(500).optional(),
})

// Blackout -------------------------------------------------------------------

export const blackoutScopeSchema = z.enum(['org', 'division', 'team', 'venue'])

export const createBlackoutSchema = dateRange(
  z.object({
    scope: blackoutScopeSchema,
    divisionId: z.string().min(1).nullish(),
    teamId: z.string().min(1).nullish(),
    venueId: z.string().min(1).nullish(),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    reason: z.string().trim().min(1).max(300),
  }),
).refine(
  (v) =>
    (v.scope === 'org' && !v.divisionId && !v.teamId && !v.venueId) ||
    (v.scope === 'division' && !!v.divisionId && !v.teamId && !v.venueId) ||
    (v.scope === 'team' && !!v.teamId && !v.divisionId && !v.venueId) ||
    (v.scope === 'venue' && !!v.venueId && !v.divisionId && !v.teamId),
  'Set exactly the one target id that matches the chosen scope.',
)
