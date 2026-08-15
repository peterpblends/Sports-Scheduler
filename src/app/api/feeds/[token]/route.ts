import { resolveFeed } from '@/lib/export/feeds'
import { icalResponse, scheduleToIcal } from '@/lib/export/ical'

type Ctx = { params: Promise<{ token: string }> }

/**
 * A live iCal subscription.
 *
 * Not wrapped in `handler`: this route is authenticated by the token in the path rather
 * than by a session, and it answers in `text/calendar`, so none of the JSON error
 * machinery applies.
 *
 * Every failure — unknown token, revoked feed, owner no longer a member, nothing
 * published — returns the same bare 404. A calendar client cannot act on a distinction,
 * and telling a prober that a token was *once* valid is a disclosure for nothing.
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params
  // Clients append `.ics` to be told what they are fetching; accept it either way.
  const clean = token.replace(/\.ics$/i, '')

  const resolved = await resolveFeed(clean)
  if (!resolved.ok) return new Response('Not found', { status: 404 })

  const domain = new URL(req.url).host

  return icalResponse(
    scheduleToIcal({
      rows: resolved.rows,
      name: resolved.name,
      description: resolved.description,
      domain,
    }),
    'schedule.ics',
  )
}
