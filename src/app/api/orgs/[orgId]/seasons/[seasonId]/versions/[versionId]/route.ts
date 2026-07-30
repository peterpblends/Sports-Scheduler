import { prisma } from '@/lib/prisma'
import { handler, notFound, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { parseSnapshot } from '@/lib/versions/snapshot'
import { formatInstantInZone } from '@/lib/time'

type Ctx = { params: Promise<{ orgId: string; seasonId: string; versionId: string }> }

/** One version's full frozen content. */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId, versionId } = await ctx.params
  await requirePermission(req, orgId, 'schedule:read')
  await assertSeasonInOrg(orgId, seasonId)

  const version = await prisma.scheduleVersion.findFirst({
    where: { id: versionId, seasonId },
    include: {
      author: { select: { name: true, email: true } },
      restoredFrom: { select: { id: true, number: true, label: true } },
    },
  })
  if (!version) throw notFound('Version not found.')

  const snapshot = parseSnapshot(version.snapshot)

  return Response.json({
    version: {
      id: version.id,
      number: version.number,
      label: version.label,
      note: version.note,
      status: version.status,
      source: version.source,
      author: version.author?.name ?? version.authorLabel,
      createdAt: version.createdAt,
      publishedAt: version.publishedAt,
      restoredFrom: version.restoredFrom,
      config: version.config,
    },
    games: snapshot.games.map((game) => ({
      gameId: game.gameId,
      round: game.roundNumber,
      division: game.divisionName,
      homeTeam: game.homeTeamName,
      awayTeam: game.awayTeamName,
      where: game.venueName ? `${game.venueName} · ${game.fieldName}` : null,
      startTime: game.startTime,
      // Rendered from the zone frozen into the snapshot, so it stays correct even if
      // the venue is later moved to a different zone.
      localStartTime: game.timezone
        ? formatInstantInZone(new Date(game.startTime), game.timezone)
        : null,
      status: game.status,
      score: game.homeScore === null ? null : `${game.homeScore}–${game.awayScore}`,
      officials: game.officials.map((o) => `${o.refereeName} (${o.position}, ${o.status})`),
    })),
  })
})
