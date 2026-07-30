import { prisma } from '../prisma'
import { formatCalendarDate } from '../time'
import type {
  BlackoutInput,
  ExistingGameInput,
  FieldInput,
  RefereeInput,
  SchedulerInput,
  SiblingGroupInput,
} from './types'

/**
 * The only place the engine meets Prisma.
 *
 * `loadSchedulerInput` reads a season's world into the engine's plain-data input, and
 * nothing downstream of it touches the database. Keeping the boundary here is what
 * lets the engine stay a pure function.
 */

export async function loadSchedulerInput(
  orgId: string,
  seasonId: string,
  config: SchedulerInput['config'],
): Promise<SchedulerInput> {
  const season = await prisma.season.findFirstOrThrow({
    where: { id: seasonId, deletedAt: null, league: { orgId, deletedAt: null } },
    include: {
      divisions: {
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
        include: {
          teams: {
            where: { deletedAt: null },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, divisionId: true, preferredVenueId: true },
          },
        },
      },
    },
  })

  const [venues, referees, blackouts, existingGames] = await Promise.all([
    prisma.venue.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        fields: {
          where: { deletedAt: null },
          orderBy: { name: 'asc' },
          include: { timeSlots: { where: { deletedAt: null } } },
        },
      },
    }),
    prisma.referee.findMany({
      where: { deletedAt: null, person: { orgId, deletedAt: null } },
      orderBy: { id: 'asc' },
      include: {
        person: { select: { id: true, name: true } },
        preferredVenues: { select: { id: true } },
        availability: { where: { deletedAt: null } },
      },
    }),
    prisma.blackoutDate.findMany({ where: { orgId, deletedAt: null }, orderBy: { id: 'asc' } }),
    prisma.game.findMany({
      where: { seasonId, deletedAt: null },
      orderBy: { startTime: 'asc' },
    }),
  ])

  const fields: FieldInput[] = venues.flatMap((venue) =>
    venue.fields.map((field) => ({
      id: field.id,
      name: field.name,
      venueId: venue.id,
      venueName: venue.name,
      timezone: venue.timezone,
      timeSlots: field.timeSlots.map((slot) => ({
        id: slot.id,
        dayOfWeek: slot.dayOfWeek,
        specificDate: slot.specificDate ? formatCalendarDate(slot.specificDate) : null,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        effectiveFrom: slot.effectiveFrom ? formatCalendarDate(slot.effectiveFrom) : null,
        effectiveTo: slot.effectiveTo ? formatCalendarDate(slot.effectiveTo) : null,
      })),
    })),
  )

  const conflictTeamIds = await refereeConflicts(
    orgId,
    referees.map((referee) => referee.personId),
  )

  const refereeInputs: RefereeInput[] = referees.map((referee) => ({
    id: referee.id,
    personId: referee.personId,
    name: referee.person.name,
    payRateCents: referee.payRateCents,
    maxGamesPerDay: referee.maxGamesPerDay,
    travelBufferMinutes: referee.travelBufferMinutes,
    preferredVenueIds: referee.preferredVenues.map((venue) => venue.id),
    availability: referee.availability.map((window) => ({
      id: window.id,
      kind: window.kind,
      dayOfWeek: window.dayOfWeek,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      effectiveFrom: window.effectiveFrom ? formatCalendarDate(window.effectiveFrom) : null,
      effectiveTo: window.effectiveTo ? formatCalendarDate(window.effectiveTo) : null,
    })),
    conflictTeamIds: conflictTeamIds.get(referee.personId) ?? [],
  }))

  const blackoutInputs: BlackoutInput[] = blackouts.map((blackout) => ({
    id: blackout.id,
    scope: blackout.scope,
    divisionId: blackout.divisionId,
    teamId: blackout.teamId,
    venueId: blackout.venueId,
    startDate: formatCalendarDate(blackout.startDate),
    endDate: formatCalendarDate(blackout.endDate),
    reason: blackout.reason,
  }))

  const existing: ExistingGameInput[] = existingGames.map((game) => ({
    id: game.id,
    divisionId: game.divisionId,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    fieldId: game.fieldId,
    startTime: game.startTime,
    durationMinutes: game.durationMinutes,
    status: game.status,
    roundNumber: game.roundNumber,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
  }))

  return {
    config,
    season: {
      id: season.id,
      startDate: formatCalendarDate(season.startDate),
      endDate: formatCalendarDate(season.endDate),
    },
    divisions: season.divisions.map((division) => ({
      id: division.id,
      name: division.name,
      teams: division.teams.map((team) => ({
        id: team.id,
        name: team.name,
        divisionId: team.divisionId,
        preferredVenueId: team.preferredVenueId,
      })),
    })),
    fields,
    referees: refereeInputs,
    blackouts: blackoutInputs,
    existingGames: existing,
    siblingGroups: await siblingGroups(orgId, seasonId),
  }
}

/**
 * Teams each official must be kept away from: those they are on the roster of, and
 * those a relative of theirs is on.
 */
async function refereeConflicts(
  orgId: string,
  personIds: string[],
): Promise<Map<string, string[]>> {
  const conflicts = new Map<string, Set<string>>()
  if (personIds.length === 0) return new Map()

  const own = await prisma.teamMembership.findMany({
    where: { deletedAt: null, personId: { in: personIds } },
    select: { personId: true, teamId: true },
  })
  for (const membership of own) {
    const set = conflicts.get(membership.personId) ?? new Set<string>()
    set.add(membership.teamId)
    conflicts.set(membership.personId, set)
  }

  const relations = await prisma.personRelationship.findMany({
    where: { deletedAt: null, personId: { in: personIds }, person: { orgId } },
    select: { personId: true, relatedPersonId: true },
  })
  if (relations.length > 0) {
    const relativeMemberships = await prisma.teamMembership.findMany({
      where: { deletedAt: null, personId: { in: relations.map((r) => r.relatedPersonId) } },
      select: { personId: true, teamId: true },
    })
    const teamsByPerson = new Map<string, string[]>()
    for (const membership of relativeMemberships) {
      teamsByPerson.set(membership.personId, [
        ...(teamsByPerson.get(membership.personId) ?? []),
        membership.teamId,
      ])
    }
    for (const relation of relations) {
      const set = conflicts.get(relation.personId) ?? new Set<string>()
      for (const teamId of teamsByPerson.get(relation.relatedPersonId) ?? []) set.add(teamId)
      conflicts.set(relation.personId, set)
    }
  }

  return new Map([...conflicts].map(([personId, teams]) => [personId, [...teams].sort()]))
}

/**
 * Groups of teams that should be kept close together: one group per family, built
 * from the person-relationship graph.
 *
 * A family with children on two teams becomes a group of those two teams, which the
 * placement scoring then tries to schedule on the same day at the same venue.
 */
async function siblingGroups(orgId: string, seasonId: string): Promise<SiblingGroupInput[]> {
  const relations = await prisma.personRelationship.findMany({
    where: { deletedAt: null, kind: 'family', person: { orgId, deletedAt: null } },
    include: {
      person: { select: { id: true, name: true } },
      relatedPerson: { select: { id: true, name: true } },
    },
  })
  if (relations.length === 0) return []

  const personIds = [...new Set(relations.flatMap((r) => [r.personId, r.relatedPersonId]))]
  const memberships = await prisma.teamMembership.findMany({
    where: {
      deletedAt: null,
      personId: { in: personIds },
      role: 'player',
      team: { deletedAt: null, division: { deletedAt: null, seasonId } },
    },
    select: { personId: true, teamId: true },
  })
  const teamsByPerson = new Map<string, string[]>()
  for (const membership of memberships) {
    teamsByPerson.set(membership.personId, [
      ...(teamsByPerson.get(membership.personId) ?? []),
      membership.teamId,
    ])
  }

  // Union-find over the family graph, so a three-sibling family is one group.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const seen = parent.get(id)
    if (!seen || seen === id) return id
    const root = find(seen)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }
  for (const id of personIds) if (!parent.has(id)) parent.set(id, id)
  for (const relation of relations) union(relation.personId, relation.relatedPersonId)

  const families = new Map<string, { people: Set<string>; teams: Set<string> }>()
  for (const id of personIds) {
    const root = find(id)
    const entry = families.get(root) ?? { people: new Set(), teams: new Set() }
    entry.people.add(id)
    for (const teamId of teamsByPerson.get(id) ?? []) entry.teams.add(teamId)
    families.set(root, entry)
  }

  const names = new Map(
    relations.flatMap((r) => [
      [r.person.id, r.person.name],
      [r.relatedPerson.id, r.relatedPerson.name],
    ]),
  )

  return [...families.entries()]
    // Only families spread across two or more teams are worth coordinating.
    .filter(([, entry]) => entry.teams.size >= 2)
    .map(([root, entry]) => ({
      label: names.get(root) ?? root,
      teamIds: [...entry.teams].sort(),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
