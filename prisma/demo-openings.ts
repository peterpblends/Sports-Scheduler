/**
 * Opens up a few officiating slots in the demo data.
 *
 * Why this needs to exist at all: the generator fills every available official to
 * their daily cap, so immediately after generating, the games that still lack a crew
 * are precisely the ones nobody available can take. Measured against the seeded org,
 * every single unstaffed game was blocked for the demo referee by their daily cap or
 * their availability — which is correct behaviour and also means the "ask to
 * officiate" flow has nothing to demonstrate on a freshly generated schedule.
 *
 * The situation where a referee *can* volunteer is a position that opens after the
 * schedule was built: somebody declines, or an assigner takes them off. So that is
 * what this script arranges — a handful of declines on days the demo referee still
 * has capacity, which is the real-world story the feature was built for.
 *
 * Strictly demo shaping. Idempotent, and it writes audit rows for what it does, the
 * same as the seed script. Never run it against real data.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const ORG_SLUG = process.env.DEMO_ORG_SLUG ?? 'riverside-youth-soccer'
/** How many positions to free. Enough to be visible, few enough to stay realistic. */
const TARGET_OPENINGS = Number(process.env.DEMO_OPENINGS ?? 6)

/** Calendar date in a zone, as YYYY-MM-DD. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: ORG_SLUG, deletedAt: null } })
  if (!org) {
    console.log(`No org with slug "${ORG_SLUG}". Nothing to do.`)
    return
  }

  // The referee who has a login is the one whose page a reviewer will look at.
  const referee = await prisma.referee.findFirst({
    where: { deletedAt: null, person: { orgId: org.id, deletedAt: null, userId: { not: null } } },
    include: { person: true },
  })
  if (!referee) {
    console.log('No referee is linked to a login. Nothing to do.')
    return
  }

  const now = new Date()

  const upcoming = await prisma.game.findMany({
    where: {
      deletedAt: null,
      startTime: { gt: now },
      status: { notIn: ['cancelled', 'postponed'] },
      season: { deletedAt: null, league: { orgId: org.id, deletedAt: null } },
    },
    orderBy: { startTime: 'asc' },
    include: {
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      field: { include: { venue: { select: { name: true, timezone: true } } } },
      officials: {
        where: { deletedAt: null },
        include: { referee: { include: { person: { select: { name: true } } } } },
      },
    },
  })

  // How loaded the demo referee already is, per local day. A day where they are at
  // cap is no use: freeing a slot there still leaves them unable to take it.
  const loadByDate = new Map<string, number>()
  for (const game of upcoming) {
    const tz = game.field?.venue.timezone ?? org.timezone
    for (const official of game.officials) {
      if (official.refereeId !== referee.id || official.status === 'declined') continue
      const key = localDate(game.startTime, tz)
      loadByDate.set(key, (loadByDate.get(key) ?? 0) + 1)
    }
  }

  const hasRoom = (game: (typeof upcoming)[number]) => {
    const tz = game.field?.venue.timezone ?? org.timezone
    return (loadByDate.get(localDate(game.startTime, tz)) ?? 0) < referee.maxGamesPerDay
  }

  /**
   * Candidates: a game on a day the referee has room, where somebody else holds a
   * position, and where the referee is not already involved. Declining another
   * official's slot on such a game is what makes it takeable.
   *
   * Adjacent slots at the other venue are still blocked by the travel buffer, so
   * this walks candidates in order and stops once enough have been freed rather
   * than assuming any one of them will work.
   */
  const candidates = upcoming.filter(
    (game) =>
      hasRoom(game) &&
      !game.officials.some((official) => official.refereeId === referee.id) &&
      game.officials.some((official) => official.status !== 'declined'),
  )

  let freed = 0
  for (const game of candidates) {
    if (freed >= TARGET_OPENINGS) break

    // Prefer giving up an assistant over the centre official: a game missing its
    // referee is a crisis, a game missing an AR is an opening.
    const giving =
      game.officials.find((o) => o.position === 'AR2' && o.status !== 'declined') ??
      game.officials.find((o) => o.position === 'AR1' && o.status !== 'declined') ??
      game.officials.find((o) => o.status !== 'declined')
    if (!giving) continue

    await prisma.$transaction(async (tx) => {
      await tx.gameOfficial.update({
        where: { id: giving.id },
        data: { status: 'declined', respondedAt: now },
      })
      await tx.auditEvent.create({
        data: {
          orgId: org.id,
          actorLabel: `${giving.referee.person.name} (demo script)`,
          entityType: 'GameOfficial',
          entityId: giving.id,
          action: 'official.declined',
          diff: { status: { before: giving.status, after: 'declined' } },
          meta: {
            source: 'demo-openings',
            gameId: game.id,
            refereeId: giving.refereeId,
            position: giving.position,
            reason: 'Freed so the demo referee has a game to volunteer for',
          },
        },
      })
    })

    const tz = game.field?.venue.timezone ?? org.timezone
    console.log(
      `  ${giving.referee.person.name} declined ${giving.position} for ` +
        `${game.homeTeam.name} v ${game.awayTeam.name} ` +
        `(${localDate(game.startTime, tz)} ${game.field?.venue.name ?? 'unplaced'})`,
    )
    freed += 1
  }

  console.log(
    `\nFreed ${freed} position${freed === 1 ? '' : 's'} on days ${referee.person.name} ` +
      `(cap ${referee.maxGamesPerDay}/day) still has room.`,
  )
  if (freed === 0) {
    console.log('Nothing was freed — every upcoming game is on a day the referee is already at cap.')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
