import { handler, requirePermission } from '@/lib/http'
import { pendingRequestsForOrg } from '@/lib/officiating'
import { formatInstantInZone } from '@/lib/time'

type Ctx = { params: Promise<{ orgId: string }> }

/**
 * Requests waiting on a decision, org-wide. The assignment board's inbox.
 *
 * Reviewers only. A referee reads their own through the board on their own page,
 * which keeps the competing-referees list out of reach.
 */
export const GET = handler<Ctx>(async (req, ctx) => {
  const { orgId } = await ctx.params
  await requirePermission(req, orgId, 'official:request:review')

  const requests = await pendingRequestsForOrg(orgId)

  return Response.json({
    requests: requests.map((request) => {
      const timezone = request.game.field?.venue.timezone ?? 'UTC'
      return {
        id: request.id,
        position: request.position,
        note: request.note,
        createdAt: request.createdAt.toISOString(),
        referee: { id: request.refereeId, name: request.referee.person.name },
        game: {
          id: request.gameId,
          match: `${request.game.homeTeam.name} v ${request.game.awayTeam.name}`,
          division: request.game.division.name,
          startTime: request.game.startTime.toISOString(),
          // Rendered here as well as sent raw: the caller should not have to know
          // which venue's zone this game belongs to in order to display it.
          localStartTime: formatInstantInZone(request.game.startTime, timezone),
          timezone,
          venue: request.game.field?.venue.name ?? null,
          field: request.game.field?.name ?? null,
        },
      }
    }),
  })
})
