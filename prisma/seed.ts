/**
 * Demo data for local development.
 *
 * Builds a realistic soccer organization: two leagues, an active season with a
 * 9-team division (odd on purpose, so bye handling gets exercised) and a second
 * 8-team division, full rosters, a pool of officials with availability and
 * blackouts, two venues with three fields between them, Saturday time slots
 * across a 12-week window, and holiday blackouts.
 *
 * That is deliberately the shape acceptance scenario 2 asks for, so phase 3 can
 * generate against it without any extra setup.
 *
 * Idempotent — safe to re-run. Every password is `demo-password-123`.
 */
import { PrismaClient, type Prisma, type Role, type TeamRole } from '@prisma/client'
import { hash } from '@node-rs/argon2'
import { createHash, randomBytes } from 'node:crypto'

const prisma = new PrismaClient()

const PASSWORD = 'demo-password-123'
const ORG_SLUG = 'riverside-youth-soccer'

/** Deterministic PRNG so re-seeding produces identical demo data. */
function makeRandom(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}
const random = makeRandom(20260730)

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!
}

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const USERS: { email: string; name: string; role: Role }[] = [
  { email: 'owner@riverside.example', name: 'Marta Ibarra', role: 'owner' },
  { email: 'admin@riverside.example', name: 'Desmond Clay', role: 'admin' },
  { email: 'scheduler@riverside.example', name: 'Priya Raman', role: 'scheduler' },
  { email: 'coach@riverside.example', name: 'Tom Vasquez', role: 'coach' },
  { email: 'referee@riverside.example', name: 'Wei Chen', role: 'referee' },
  { email: 'viewer@riverside.example', name: 'Jules Petit', role: 'viewer' },
]

const U12_TEAMS = [
  { name: 'Riverside Rovers', primary: '#1b7f3a', secondary: '#ffffff' },
  { name: 'Oakhurst Owls', primary: '#8b3fa8', secondary: '#f5c542' },
  { name: 'Bayside Breakers', primary: '#1f6fb2', secondary: '#ffffff' },
  { name: 'Millfield Falcons', primary: '#c2410c', secondary: '#1f2937' },
  { name: 'Cedar Creek United', primary: '#0f766e', secondary: '#fef3c7' },
  { name: 'Northgate Nomads', primary: '#4338ca', secondary: '#e0e7ff' },
  { name: 'Harborview Hawks', primary: '#b91c1c', secondary: '#fecaca' },
  { name: 'Sunnyvale Strikers', primary: '#ca8a04', secondary: '#1f2937' },
  { name: 'Westbrook Wolves', primary: '#374151', secondary: '#9ca3af' },
]

const U10_TEAMS = [
  'Lakeside Lions',
  'Fairmont Foxes',
  'Brookdale Bees',
  'Glenwood Gulls',
  'Ridgeway Ravens',
  'Stonebridge Sharks',
  'Ashford Arrows',
  'Kingsley Comets',
]

const FIRST_NAMES = [
  'Ana', 'Ben', 'Cleo', 'Dev', 'Elena', 'Femi', 'Gus', 'Hana', 'Ines', 'Jonah',
  'Kai', 'Lena', 'Mateo', 'Nora', 'Omar', 'Pia', 'Quinn', 'Rosa', 'Sam', 'Tariq',
  'Uma', 'Vik', 'Wren', 'Xavi', 'Yuki', 'Zane', 'Ayla', 'Bruno', 'Cora', 'Dante',
]
const LAST_NAMES = [
  'Alvarez', 'Bennett', 'Castillo', 'Dubois', 'Egan', 'Ferraro', 'Gupta', 'Haddad',
  'Ibrahim', 'Jensen', 'Kowalski', 'Lombardi', 'Mensah', 'Nakamura', 'Okafor',
  'Petrov', 'Quintana', 'Rossi', 'Silva', 'Tanaka', 'Ueda', 'Vargas', 'Whitlock',
]

const REFEREES = [
  { name: 'Wei Chen', level: 'Grade 6', payCents: 5500, maxPerDay: 4, email: 'referee@riverside.example' },
  { name: 'Sofia Marchetti', level: 'Grade 7', payCents: 4500, maxPerDay: 3 },
  { name: 'Andre Boateng', level: 'Grade 7', payCents: 4500, maxPerDay: 3 },
  { name: 'Hannah Lindqvist', level: 'Grade 8', payCents: 3500, maxPerDay: 2 },
  { name: 'Diego Salas', level: 'Grade 8', payCents: 3500, maxPerDay: 2 },
  { name: 'Priya Kulkarni', level: 'Grade 6', payCents: 5500, maxPerDay: 4 },
]

async function main() {
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 })

  // --- organization and logins -------------------------------------------------

  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: { timezone: 'America/Los_Angeles' },
    create: {
      name: 'Riverside Youth Soccer',
      slug: ORG_SLUG,
      timezone: 'America/Los_Angeles',
      settings: { sport: 'soccer' },
    },
  })

  // Re-seeding replaces the demo content but keeps the org, its logins and the
  // audit trail. Soft deletes, never DELETE — same rule the app itself follows.
  await retireExistingDemoData(org.id)

  const users = new Map<string, string>()
  for (const person of USERS) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { name: person.name },
      create: { email: person.email, name: person.name, passwordHash },
    })
    users.set(person.email, user.id)
    await prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      update: { role: person.role, deletedAt: null },
      create: { userId: user.id, orgId: org.id, role: person.role },
    })
  }
  const ownerId = users.get('owner@riverside.example')!

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    diff: Prisma.InputJsonValue = {},
  ) =>
    prisma.auditEvent.create({
      data: {
        orgId: org.id,
        actorId: ownerId,
        actorLabel: 'seed script',
        entityType,
        entityId,
        action,
        diff,
        meta: { source: 'seed' },
      },
    })

  // --- venues, fields and Saturday availability -------------------------------

  const riverside = await prisma.venue.create({
    data: {
      orgId: org.id,
      name: 'Riverside Park',
      address: '1200 River Road, Riverside',
      timezone: 'America/Los_Angeles',
      notes: 'Main complex. Parking fills up before 9am.',
    },
  })
  const eastside = await prisma.venue.create({
    data: {
      orgId: org.id,
      name: 'Eastside Sports Complex',
      address: '88 Commerce Way, Eastside',
      timezone: 'America/Los_Angeles',
      notes: 'Turf. Lights available until 9pm.',
    },
  })
  await audit('Venue', riverside.id, 'venue.created', { name: { before: null, after: riverside.name } })
  await audit('Venue', eastside.id, 'venue.created', { name: { before: null, after: eastside.name } })

  const fields = []
  for (const [venue, names] of [
    [riverside, ['Field 1', 'Field 2']],
    [eastside, ['Turf A']],
  ] as const) {
    for (const name of names) {
      const field = await prisma.field.create({ data: { venueId: venue.id, name } })
      fields.push(field)
      // Saturdays 8am - 6pm local across the season window. Stored as local
      // minutes, so 8am stays 8am when DST shifts in mid-March.
      await prisma.timeSlot.create({
        data: {
          fieldId: field.id,
          dayOfWeek: 6,
          startMinute: 8 * 60,
          endMinute: 18 * 60,
          effectiveFrom: date('2026-03-07'),
          effectiveTo: date('2026-05-30'),
          notes: 'Season Saturdays',
        },
      })
      // Sunday afternoons, for makeups.
      await prisma.timeSlot.create({
        data: {
          fieldId: field.id,
          dayOfWeek: 0,
          startMinute: 13 * 60,
          endMinute: 17 * 60,
          effectiveFrom: date('2026-03-07'),
          effectiveTo: date('2026-05-30'),
          notes: 'Makeup window',
        },
      })
      await audit('Field', field.id, 'field.created', { name: { before: null, after: name } })
    }
  }

  // --- leagues, season, divisions, teams --------------------------------------

  const recLeague = await prisma.league.create({
    data: {
      orgId: org.id,
      name: 'Recreational',
      sport: 'soccer',
      description: 'Everyone plays. Balanced teams, no standings pressure.',
    },
  })
  const compLeague = await prisma.league.create({
    data: {
      orgId: org.id,
      name: 'Competitive',
      sport: 'soccer',
      description: 'Tryout-based, travels regionally.',
    },
  })
  await audit('League', recLeague.id, 'league.created', { name: { before: null, after: 'Recreational' } })
  await audit('League', compLeague.id, 'league.created', { name: { before: null, after: 'Competitive' } })

  const season = await prisma.season.create({
    data: {
      leagueId: recLeague.id,
      name: 'Spring 2026',
      // 12 Saturdays: Mar 7 through May 23, ending May 30.
      startDate: date('2026-03-07'),
      endDate: date('2026-05-30'),
      status: 'active',
    },
  })
  await prisma.season.create({
    data: {
      leagueId: compLeague.id,
      name: 'Spring 2026',
      startDate: date('2026-03-07'),
      endDate: date('2026-05-30'),
      status: 'draft',
    },
  })
  await audit('Season', season.id, 'season.created', { name: { before: null, after: 'Spring 2026' } })

  const u12 = await prisma.division.create({
    data: {
      seasonId: season.id,
      name: 'U12 Boys',
      description: 'Nine teams — odd count, so every round has a bye.',
    },
  })
  const u10 = await prisma.division.create({
    data: { seasonId: season.id, name: 'U10 Girls', description: 'Eight teams.' },
  })
  await audit('Division', u12.id, 'division.created', { name: { before: null, after: 'U12 Boys' } })
  await audit('Division', u10.id, 'division.created', { name: { before: null, after: 'U10 Girls' } })

  const venueIds = [riverside.id, eastside.id]
  const teams: { id: string; name: string; divisionId: string }[] = []

  for (const [index, spec] of U12_TEAMS.entries()) {
    const team = await prisma.team.create({
      data: {
        divisionId: u12.id,
        name: spec.name,
        primaryColor: spec.primary,
        secondaryColor: spec.secondary,
        preferredVenueId: venueIds[index % venueIds.length]!,
      },
    })
    teams.push(team)
    await audit('Team', team.id, 'team.created', { name: { before: null, after: spec.name } })
  }

  for (const [index, name] of U10_TEAMS.entries()) {
    const team = await prisma.team.create({
      data: {
        divisionId: u10.id,
        name,
        primaryColor: pick(['#1b7f3a', '#1f6fb2', '#8b3fa8', '#c2410c']),
        preferredVenueId: venueIds[index % venueIds.length]!,
      },
    })
    teams.push(team)
  }

  // --- people and rosters -----------------------------------------------------

  let nameCounter = 0
  const nextPersonName = () => {
    nameCounter++
    return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)} ${nameCounter <= 999 ? '' : ''}`.trim()
  }

  const coachUserId = users.get('coach@riverside.example')!
  let linkedCoach = false

  for (const team of teams) {
    // One head coach per team; the demo coach login is linked to the first U12
    // team so that own-team permissions are demonstrable straight after seeding.
    const coachName = !linkedCoach && team.divisionId === u12.id ? 'Tom Vasquez' : nextPersonName()
    const coach = await prisma.person.create({
      data: {
        orgId: org.id,
        name: coachName,
        email: !linkedCoach && team.divisionId === u12.id
          ? 'coach@riverside.example'
          : `${coachName.toLowerCase().replace(/\W+/g, '.')}@example.com`,
        phone: `555-01${String(nameCounter).padStart(2, '0')}`,
        userId: !linkedCoach && team.divisionId === u12.id ? coachUserId : null,
      },
    })
    if (!linkedCoach && team.divisionId === u12.id) linkedCoach = true

    await prisma.teamMembership.create({
      data: { teamId: team.id, personId: coach.id, role: 'coach', activeFrom: date('2026-02-01') },
    })

    const manager = await prisma.person.create({
      data: { orgId: org.id, name: nextPersonName(), phone: `555-02${String(nameCounter).padStart(2, '0')}` },
    })
    await prisma.teamMembership.create({
      data: { teamId: team.id, personId: manager.id, role: 'manager' as TeamRole },
    })

    // 11 players each, with jersey numbers unique within the team.
    for (let jersey = 1; jersey <= 11; jersey++) {
      const player = await prisma.person.create({
        data: {
          orgId: org.id,
          name: nextPersonName(),
          dob: date(`${team.divisionId === u12.id ? 2014 : 2016}-0${(jersey % 9) + 1}-1${jersey % 9}`),
        },
      })
      await prisma.teamMembership.create({
        data: {
          teamId: team.id,
          personId: player.id,
          role: 'player',
          jerseyNumber: String(jersey),
          activeFrom: date('2026-02-01'),
        },
      })
    }
  }

  // A sibling pair across two U12 teams, so the "keep siblings' games close
  // together" weighting and the conflict-of-interest rule both have real data.
  const rovers = teams.find((t) => t.name === 'Riverside Rovers')!
  const owls = teams.find((t) => t.name === 'Oakhurst Owls')!
  const siblingA = await prisma.person.create({
    data: { orgId: org.id, name: 'Nadia Okonjo', dob: date('2014-04-02') },
  })
  const siblingB = await prisma.person.create({
    data: { orgId: org.id, name: 'Tobi Okonjo', dob: date('2014-04-02') },
  })
  await prisma.teamMembership.create({
    data: { teamId: rovers.id, personId: siblingA.id, role: 'player', jerseyNumber: '12' },
  })
  await prisma.teamMembership.create({
    data: { teamId: owls.id, personId: siblingB.id, role: 'player', jerseyNumber: '12' },
  })
  for (const [a, b] of [
    [siblingA.id, siblingB.id],
    [siblingB.id, siblingA.id],
  ]) {
    await prisma.personRelationship.create({
      data: { personId: a!, relatedPersonId: b!, kind: 'family' },
    })
  }

  // --- officials --------------------------------------------------------------

  for (const spec of REFEREES) {
    const person = await prisma.person.create({
      data: {
        orgId: org.id,
        name: spec.name,
        email: spec.email ?? `${spec.name.toLowerCase().replace(/\W+/g, '.')}@example.com`,
        userId: spec.email ? users.get(spec.email) ?? null : null,
      },
    })

    const referee = await prisma.referee.create({
      data: {
        personId: person.id,
        certificationLevel: spec.level,
        payRateCents: spec.payCents,
        maxGamesPerDay: spec.maxPerDay,
        travelBufferMinutes: 30,
        preferredVenues: { connect: [{ id: pick(venueIds) === riverside.id ? riverside.id : eastside.id }] },
      },
    })

    // Saturdays, with the pool split across morning and afternoon.
    const morning = random() < 0.5
    await prisma.refereeAvailability.create({
      data: {
        refereeId: referee.id,
        kind: 'weekly',
        dayOfWeek: 6,
        startMinute: morning ? 8 * 60 : 12 * 60,
        endMinute: morning ? 14 * 60 : 18 * 60,
        effectiveFrom: date('2026-03-07'),
        effectiveTo: date('2026-05-30'),
      },
    })
    await audit('Referee', referee.id, 'referee.created', {
      certificationLevel: { before: null, after: spec.level },
    })
  }

  // One official with heavy blackouts — the awkward case the engine fixtures need.
  const busy = await prisma.referee.findFirstOrThrow({
    where: { person: { name: 'Hannah Lindqvist', orgId: org.id } },
  })
  for (const [from, to, reason] of [
    ['2026-03-14', '2026-03-28', 'Out of state'],
    ['2026-04-11', '2026-04-11', 'Wedding'],
    ['2026-05-02', '2026-05-16', 'Exams'],
  ] as const) {
    await prisma.refereeAvailability.create({
      data: {
        refereeId: busy.id,
        kind: 'blackout',
        effectiveFrom: date(from),
        effectiveTo: date(to),
        reason,
      },
    })
  }

  // --- blackout dates ---------------------------------------------------------

  const blackouts = [
    { scope: 'org' as const, start: '2026-04-05', end: '2026-04-05', reason: 'Easter Sunday' },
    { scope: 'org' as const, start: '2026-05-25', end: '2026-05-25', reason: 'Memorial Day' },
    {
      scope: 'venue' as const,
      start: '2026-04-18',
      end: '2026-04-19',
      reason: 'Field maintenance and reseeding',
      venueId: riverside.id,
    },
    {
      scope: 'division' as const,
      start: '2026-05-09',
      end: '2026-05-09',
      reason: 'U12 regional tournament',
      divisionId: u12.id,
    },
    {
      scope: 'team' as const,
      start: '2026-03-21',
      end: '2026-03-21',
      reason: 'Team travelling to a friendly',
      teamId: owls.id,
    },
  ]
  for (const b of blackouts) {
    const row = await prisma.blackoutDate.create({
      data: {
        orgId: org.id,
        scope: b.scope,
        divisionId: 'divisionId' in b ? b.divisionId : null,
        teamId: 'teamId' in b ? b.teamId : null,
        venueId: 'venueId' in b ? b.venueId : null,
        startDate: date(b.start),
        endDate: date(b.end),
        reason: b.reason,
      },
    })
    await audit('BlackoutDate', row.id, 'blackoutdate.created', {
      reason: { before: null, after: b.reason },
    })
  }

  // --- a pending invitation ---------------------------------------------------

  const inviteToken = randomBytes(32).toString('base64url')
  await prisma.invitation.updateMany({
    where: { orgId: org.id, email: 'newcoach@riverside.example', acceptedAt: null },
    data: { revokedAt: new Date() },
  })
  await prisma.invitation.create({
    data: {
      orgId: org.id,
      email: 'newcoach@riverside.example',
      role: 'coach',
      tokenHash: createHash('sha256').update(inviteToken).digest('hex'),
      createdById: ownerId,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  })

  // --- summary ----------------------------------------------------------------

  const counts = {
    leagues: await prisma.league.count({ where: { orgId: org.id, deletedAt: null } }),
    teams: await prisma.team.count({
      where: { deletedAt: null, division: { season: { league: { orgId: org.id } } } },
    }),
    people: await prisma.person.count({ where: { orgId: org.id, deletedAt: null } }),
    referees: await prisma.referee.count({
      where: { deletedAt: null, person: { orgId: org.id, deletedAt: null } },
    }),
    venues: await prisma.venue.count({ where: { orgId: org.id, deletedAt: null } }),
    fields: await prisma.field.count({ where: { deletedAt: null, venue: { orgId: org.id } } }),
    blackouts: await prisma.blackoutDate.count({ where: { orgId: org.id, deletedAt: null } }),
  }

  const base = process.env.APP_URL ?? 'http://localhost:3000'
  console.log(`\nSeeded "Riverside Youth Soccer"  ->  ${base}/app/${ORG_SLUG}\n`)
  console.log(
    `  ${counts.leagues} leagues · ${counts.teams} teams · ${counts.people} people · ` +
      `${counts.referees} officials · ${counts.venues} venues / ${counts.fields} fields · ` +
      `${counts.blackouts} blackouts`,
  )
  console.log(`\n  U12 Boys has 9 teams; Saturdays 8am-6pm local, Mar 7 - May 30 2026.`)
  console.log(`\n  Sign in with any of these — password: ${PASSWORD}`)
  for (const u of USERS) console.log(`    ${u.role.padEnd(10)} ${u.email}`)
  console.log(`\n  Pending invite:\n    ${base}/accept-invite?token=${inviteToken}\n`)
}

/**
 * Soft-deletes the previous run's demo content so re-seeding is idempotent
 * without discarding history. Logins, memberships and audit rows are left alone.
 */
async function retireExistingDemoData(orgId: string) {
  const deletedAt = new Date()
  const inOrg = { deletedAt: null }

  await prisma.gameOfficial.updateMany({
    where: { ...inOrg, game: { season: { league: { orgId } } } },
    data: { deletedAt },
  })
  await prisma.game.updateMany({
    where: { ...inOrg, season: { league: { orgId } } },
    data: { deletedAt },
  })
  await prisma.refereeAvailability.updateMany({
    where: { ...inOrg, referee: { person: { orgId } } },
    data: { deletedAt },
  })
  await prisma.referee.updateMany({
    where: { ...inOrg, person: { orgId } },
    data: { deletedAt },
  })
  await prisma.teamMembership.updateMany({
    where: { ...inOrg, person: { orgId } },
    data: { deletedAt },
  })
  await prisma.personRelationship.updateMany({
    where: { ...inOrg, person: { orgId } },
    data: { deletedAt },
  })
  // Unlink demo Person rows from logins first: the link is unique, so a retired
  // person would otherwise block the next run from linking the same user.
  await prisma.person.updateMany({ where: { orgId, deletedAt: null }, data: { userId: null } })
  await prisma.person.updateMany({ where: { orgId, ...inOrg }, data: { deletedAt } })
  await prisma.timeSlot.updateMany({
    where: { ...inOrg, field: { venue: { orgId } } },
    data: { deletedAt },
  })
  await prisma.field.updateMany({ where: { ...inOrg, venue: { orgId } }, data: { deletedAt } })
  await prisma.blackoutDate.updateMany({ where: { orgId, ...inOrg }, data: { deletedAt } })
  await prisma.team.updateMany({
    where: { ...inOrg, division: { season: { league: { orgId } } } },
    data: { deletedAt },
  })
  await prisma.division.updateMany({
    where: { ...inOrg, season: { league: { orgId } } },
    data: { deletedAt },
  })
  await prisma.season.updateMany({ where: { ...inOrg, league: { orgId } }, data: { deletedAt } })
  await prisma.league.updateMany({ where: { orgId, ...inOrg }, data: { deletedAt } })
  await prisma.venue.updateMany({ where: { orgId, ...inOrg }, data: { deletedAt } })
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
