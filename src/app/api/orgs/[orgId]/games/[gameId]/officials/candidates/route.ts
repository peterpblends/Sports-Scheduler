import { prisma } from '@/lib/prisma'
import { handler, requirePermission } from '@/lib/http'
import { assertGameInOrg } from '@/lib/scope'
import { detectOfficialConflicts } from '@/lib/conflicts'
import { calendarDateInZone } from '@/lib/time'

type Ctx = { params: Promise<{ orgId: string; gameId: string }> }

/**
 * Who can take this game, and for everyone who cannot, why not.
 *
 * The assignment board needs the reasons, not just a filtered list: an assigner
 * deciding whether to override has to see that the objection is a daily cap rather
 * than a conflict of interest. So every official is returned, each with the same
 * conflict list the POST would refuse on, and the UI sorts rather than hides.
 *
 * Conflicts are evaluated per official, which is a handful of queries each. Fine for
 * an officiating pool, and the endpoint is only hit when a picker is opened.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, gameId } = await ctx.params
  await requirePermission(req, orgId, 'official:assign')
  const game = await assertGameInOrg(orgId, gameId)

  const [referees, assigned] = await Promise.all([
    prisma.referee.findMany({
      where: { deletedAt: null, person: { orgId, deletedAt: null } },
      orderBy: { person: { name: 'asc' } },
      include: {
        person: { select: { id: true, name: true } },
        assignments: {
          where: { deletedAt: null, status: { not: 'declined' }, game: { deletedAt: null } },
          select: { game: { select: { startTime: true, field: { select: { venue: { select: { timezone: true } } } } } } },
        },
      },
    }),
    prisma.gameOfficial.findMany({
      where: { gameId, deletedAt: null },
      select: { refereeId: true },
    }),
  ])

  const onThisGame = new Set(assigned.map((row) => row.refereeId))
  const tz = game.field?.venue.timezone ?? 'UTC'
  const gameDate = calendarDateInZone(game.startTime, tz).getTime()

  const candidates = await Promise.all(
    referees.map(async (referee) => {
      // Already on the crew: no point costing out the conflict check.
      if (onThisGame.has(referee.id)) {
        return {
          refereeId: referee.id,
          name: referee.person.name,
          certification: referee.certificationLevel,
          alreadyAssigned: true,
          gamesThatDay: 0,
          maxGamesPerDay: referee.maxGamesPerDay,
          conflicts: [],
        }
      }

      const gamesThatDay = referee.assignments.filter((assignment) => {
        const assignmentTz = assignment.game.field?.venue.timezone ?? tz
        return calendarDateInZone(assignment.game.startTime, assignmentTz).getTime() === gameDate
      }).length

      return {
        refereeId: referee.id,
        name: referee.person.name,
        certification: referee.certificationLevel,
        alreadyAssigned: false,
        gamesThatDay,
        maxGamesPerDay: referee.maxGamesPerDay,
        conflicts: await detectOfficialConflicts(orgId, gameId, referee.id),
      }
    }),
  )

  return Response.json({
    candidates: candidates.sort(
      (a, b) =>
        Number(a.alreadyAssigned) - Number(b.alreadyAssigned) ||
        a.conflicts.length - b.conflicts.length ||
        a.gamesThatDay - b.gamesThatDay ||
        a.name.localeCompare(b.name),
    ),
  })
})
