import { prisma } from '@/lib/prisma'
import { badRequest, handler, notFound, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { captureSnapshot } from '@/lib/versions/service'
import { diffSnapshots, parseSnapshot, type ScheduleSnapshot } from '@/lib/versions/snapshot'
import { formatInstantInZone } from '@/lib/time'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

/**
 * Side-by-side diff between any two versions.
 *
 * `from` and `to` are version ids, or the literal `live` for the season's current
 * unversioned working set — which is how an admin sees what hand-editing has changed
 * since the last save.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  await requirePermission(req, orgId, 'schedule:read')
  await assertSeasonInOrg(orgId, seasonId)

  const params = new URL(req.url).searchParams
  const fromId = params.get('from')
  const toId = params.get('to')
  if (!fromId || !toId) throw badRequest('Pass from and to version ids.')

  const [from, to] = await Promise.all([
    loadSide(seasonId, fromId),
    loadSide(seasonId, toId),
  ])

  const diff = diffSnapshots(from.snapshot, to.snapshot)

  /** Renders an instant in the venue's zone, falling back to ISO when unknown. */
  const local = (startTime: string, timezone: string | null) =>
    timezone ? formatInstantInZone(new Date(startTime), timezone) : startTime

  return Response.json({
    from: from.meta,
    to: to.meta,
    counts: diff.counts,
    added: diff.added.map((game) => ({
      gameId: game.gameId,
      round: game.roundNumber,
      division: game.divisionName,
      match: `${game.homeTeamName} v ${game.awayTeamName}`,
      where: game.venueName ? `${game.venueName} · ${game.fieldName}` : null,
      localStartTime: local(game.startTime, game.timezone),
    })),
    removed: diff.removed.map((game) => ({
      gameId: game.gameId,
      round: game.roundNumber,
      division: game.divisionName,
      match: `${game.homeTeamName} v ${game.awayTeamName}`,
      where: game.venueName ? `${game.venueName} · ${game.fieldName}` : null,
      localStartTime: local(game.startTime, game.timezone),
    })),
    moved: diff.moved.map((entry) => ({
      gameId: entry.after.gameId,
      round: entry.after.roundNumber,
      division: entry.after.divisionName,
      match: `${entry.after.homeTeamName} v ${entry.after.awayTeamName}`,
      matchedBy: entry.matchedBy,
      timeChanged: entry.timeChanged,
      fieldChanged: entry.fieldChanged,
      statusChanged: entry.statusChanged,
      scoreChanged: entry.scoreChanged,
      minutesMoved: entry.minutesMoved,
      before: {
        localStartTime: local(entry.before.startTime, entry.before.timezone),
        where: entry.before.venueName
          ? `${entry.before.venueName} · ${entry.before.fieldName}`
          : null,
        status: entry.before.status,
        score:
          entry.before.homeScore === null
            ? null
            : `${entry.before.homeScore}–${entry.before.awayScore}`,
      },
      after: {
        localStartTime: local(entry.after.startTime, entry.after.timezone),
        where: entry.after.venueName ? `${entry.after.venueName} · ${entry.after.fieldName}` : null,
        status: entry.after.status,
        score:
          entry.after.homeScore === null ? null : `${entry.after.homeScore}–${entry.after.awayScore}`,
      },
    })),
    officialsChanged: diff.officialsChanged.map((entry) => ({
      gameId: entry.game.gameId,
      match: `${entry.game.homeTeamName} v ${entry.game.awayTeamName}`,
      localStartTime: local(entry.game.startTime, entry.game.timezone),
      added: entry.added.map((o) => `${o.refereeName} (${o.position})`),
      removed: entry.removed.map((o) => `${o.refereeName} (${o.position})`),
      statusChanged: entry.statusChanged.map(
        (change) =>
          `${change.after.refereeName} (${change.after.position}): ${change.before.status} → ${change.after.status}`,
      ),
    })),
  })
})

type Side = {
  snapshot: ScheduleSnapshot
  meta: {
    id: string
    number: number | null
    label: string
    status: string
    createdAt: Date | null
    author: string | null
    gameCount: number
  }
}

async function loadSide(seasonId: string, id: string): Promise<Side> {
  if (id === 'live') {
    const snapshot = await captureSnapshot(seasonId)
    return {
      snapshot,
      meta: {
        id: 'live',
        number: null,
        label: 'Current working schedule',
        status: 'live',
        createdAt: null,
        author: null,
        gameCount: snapshot.games.length,
      },
    }
  }

  const version = await prisma.scheduleVersion.findFirst({
    where: { id, seasonId },
    include: { author: { select: { name: true } } },
  })
  if (!version) throw notFound('Version not found.')

  const snapshot = parseSnapshot(version.snapshot)
  return {
    snapshot,
    meta: {
      id: version.id,
      number: version.number,
      label: version.label,
      status: version.status,
      createdAt: version.createdAt,
      author: version.author?.name ?? version.authorLabel,
      gameCount: snapshot.games.length,
    },
  }
}
