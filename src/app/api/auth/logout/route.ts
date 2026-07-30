import { clearedSessionCookie, getActorFromRequest, revokeSession } from '@/lib/session'
import { handler } from '@/lib/http'

export const POST = handler(async (req) => {
  const actor = await getActorFromRequest(req)
  if (actor) await revokeSession(actor.sessionId)
  // Always clear the cookie, even if the token was already invalid.
  return Response.json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie() } })
})
