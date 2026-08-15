import { ZodError, type ZodTypeAny, type output } from 'zod'
import type { Actor } from './session'
import { getActorFromRequest } from './session'
import { can, roleIn, type Permission } from './authz'
import type { Role } from '@prisma/client'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d)
export const unauthorized = (m = 'Not signed in.') => new HttpError(401, m)
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m)
export const notFound = (m = 'Not found.') => new HttpError(404, m)
export const conflict = (m: string) => new HttpError(409, m)

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init)
}

/**
 * Wraps a route handler so thrown `HttpError`s become clean JSON and anything
 * unexpected becomes a 500 without leaking internals to the client.
 */
export function handler<Ctx>(
  fn: (req: Request, ctx: Ctx) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      // Rejecting a cross-site write here rather than per route means a new endpoint
      // is covered the moment it is wrapped, which is the only way this stays true.
      assertNotCrossSite(req)
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof HttpError) {
        const headers: Record<string, string> = {}
        // A 429 without Retry-After leaves a well-behaved client guessing, and
        // guessing usually means retrying immediately.
        const retryAfter = (err.details as { retryAfterSeconds?: number } | null)?.retryAfterSeconds
        if (err.status === 429 && typeof retryAfter === 'number') {
          headers['retry-after'] = String(retryAfter)
        }
        return Response.json(
          { error: err.message, details: err.details ?? null },
          { status: err.status, headers },
        )
      }
      if (err instanceof ZodError) {
        return Response.json({ error: 'Validation failed.', details: err.flatten() }, { status: 400 })
      }
      // A unique-constraint violation means a concurrent request got there first.
      // That is a conflict, not a server fault, and the database is the only place
      // it can be detected — an application-level "does this exist yet" check is a
      // read followed by a write, and two callers can pass it simultaneously.
      const conflictMessage = uniqueViolationMessage(err)
      if (conflictMessage) {
        return Response.json({ error: conflictMessage }, { status: 409 })
      }
      // Logged server-side with no request body, so a failure that happens to carry
      // a password or token in its payload does not end up in the log stream. The
      // client is told nothing beyond that it failed.
      console.error('[unhandled route error]', err instanceof Error ? err.stack : err)
      return Response.json({ error: 'Something went wrong.' }, { status: 500 })
    }
  }
}

/**
 * Turns a Prisma unique-constraint violation into a message worth reading.
 *
 * Keyed on the index name so the answer names the actual clash. The fallback is
 * deliberately vague rather than echoing the constraint back to the client, which
 * would leak schema detail for no benefit.
 *
 * Matched structurally rather than with `instanceof PrismaClientKnownRequestError`,
 * because importing that pulls the Prisma runtime into every module that touches
 * `handler`.
 */
function uniqueViolationMessage(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  if ((err as { code?: unknown }).code !== 'P2002') return null

  const meta = (err as { meta?: { modelName?: unknown; target?: unknown } }).meta
  const model = typeof meta?.modelName === 'string' ? meta.modelName : ''
  // Prisma reports the offending *columns*, not the index name — even for an index
  // it does not know about, which is the case for the partial ones added in raw SQL.
  const columns = Array.isArray(meta?.target)
    ? [...meta.target].map(String).sort().join(',')
    : ''

  const messages: Record<string, string> = {
    'GameOfficial:gameId,position': 'Somebody else was assigned to that position first.',
    'GameOfficial:gameId,refereeId': 'That official is already on the crew for this game.',
    'OfficiatingRequest:gameId,refereeId': 'You already have a request pending on that game.',
  }

  return (
    messages[`${model}:${columns}`] ??
    'That conflicts with something created a moment ago. Reload and try again.'
  )
}

/** Methods that cannot change state, and so cannot be a CSRF target. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Defence in depth against cross-site state change.
 *
 * `SameSite=Lax` on the session cookie is the primary control and already stops a
 * cross-site POST from carrying credentials. This is the second layer, for the cases
 * Lax does not cover on its own: a browser that does not implement SameSite, and any
 * future endpoint that changes state on a method Lax still sends cookies for.
 *
 * Only *contradicted* provenance is rejected, never missing provenance. A request
 * with no `Origin` and no `Sec-Fetch-Site` is not a browser form post — it is curl, a
 * calendar client, or the test suite calling a handler directly — and none of those
 * carry ambient cookies from a victim's session, so none of them is a CSRF vector.
 * Rejecting them instead would break every legitimate API client while adding no
 * security.
 */
export function assertNotCrossSite(req: Request): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return

  // Chrome, Firefox and Safari all send this, and it is unforgeable by page script.
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw forbidden('Cross-site requests are not accepted.')
  }

  const origin = req.headers.get('origin')
  if (!origin) return

  // `null` is what a sandboxed or opaque origin sends. It is never this app.
  if (origin === 'null') throw forbidden('Cross-site requests are not accepted.')

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw forbidden('Cross-site requests are not accepted.')
  }

  // Compared against the forwarded host when present, because that is the host the
  // browser actually addressed and therefore the one the Origin will match.
  const expected = req.headers.get('x-forwarded-host') ?? new URL(req.url).host
  if (originHost !== expected) {
    throw forbidden('Cross-site requests are not accepted.')
  }
}

/**
 * Parses and validates a JSON body.
 *
 * Typed on the schema rather than on a single `T` so that schemas which transform
 * (`"08:00"` -> `480`) or fill defaults report their *output* type to callers.
 * Collapsing input and output into one parameter silently widens every
 * defaulted field back to `| undefined`.
 */
/**
 * Largest JSON body any endpoint accepts, in bytes.
 *
 * Sized for the biggest legitimate payload — a roster CSV, itself capped at 1 MB by
 * its own schema — plus room for the JSON envelope and escaping. Without a cap,
 * `req.json()` buffers whatever it is sent before Zod ever sees it, so a single
 * request can exhaust the process's memory; the schema's own `.max()` is enforced far
 * too late to help.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

export const payloadTooLarge = (m = 'Request body is too large.') => new HttpError(413, m)

export async function parseBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<output<S>> {
  // Cheap rejection first, before a byte of the body is read.
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw payloadTooLarge()

  let text: string
  try {
    text = await req.text()
  } catch {
    throw badRequest('Expected a JSON body.')
  }

  // Content-Length is a claim, not a fact — a chunked request need not send one, and
  // one that does can lie. Measured in bytes rather than characters so a body of
  // multi-byte characters cannot slip past a length written for ASCII.
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw payloadTooLarge()

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw badRequest('Expected a JSON body.')
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new HttpError(400, 'Validation failed.', result.error.flatten())
  }
  return result.data
}

/** Requires a valid session. */
export async function requireActor(req: Request): Promise<Actor> {
  const actor = await getActorFromRequest(req)
  if (!actor) throw unauthorized()
  return actor
}

/**
 * The single gate every org-scoped endpoint goes through: valid session, real
 * membership in the target org, and the named permission held by that role.
 *
 * Membership is re-read from the database on every request via the session
 * lookup, so a role revoked a second ago is enforced on the next call. Nothing
 * here consults client-supplied role information.
 */
export async function requirePermission(
  req: Request,
  orgId: string,
  permission: Permission,
): Promise<{ actor: Actor; role: Role }> {
  const actor = await requireActor(req)
  const role = roleIn(actor, orgId)
  // Non-members get 404 rather than 403: whether an org exists is itself private.
  if (!role) throw notFound('Organization not found.')
  if (!can(role, permission)) throw forbidden()
  return { actor, role }
}

/**
 * The client address, as far as it can be trusted.
 *
 * `X-Forwarded-For` is a list that each hop appends to, so the **leftmost** entry is
 * whatever the original caller chose to send — fully attacker-controlled. Reading
 * that entry, as this used to, means anyone can write arbitrary values into audit
 * rows and session records, and can defeat any per-IP rate limit by varying a header.
 *
 * The trustworthy part is the right-hand end: the entry appended by your own reverse
 * proxy. `TRUSTED_PROXY_HOPS` says how many proxies sit in front of the app — 1 for
 * the documented Vercel and single-nginx deployments — and the address is taken that
 * many places from the right. Set it to 0 when nothing is in front, and the header is
 * ignored entirely rather than believed.
 *
 * With no proxy and no configuration there is genuinely nothing authoritative to
 * read: the Web `Request` API exposes no socket address. Returning null in that case
 * is deliberate — a null groups nothing together, which fails safe for rate limiting,
 * whereas a spoofable value silently partitions every attacker into their own bucket.
 */
export function clientIp(req: Request): string | null {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS ?? '1')
  const hops = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 1
  if (hops === 0) return null

  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    // Nth from the right. If the list is shorter than the configured hop count the
    // request did not come through the expected chain, so nothing here is
    // authoritative and it is treated as unknown.
    const candidate = parts[parts.length - hops]
    if (candidate) return candidate
    return null
  }

  // Single-value headers a proxy sets directly; no list, so no attacker-chosen prefix.
  return req.headers.get('x-real-ip')
}
