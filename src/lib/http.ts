import { ZodError, type ZodType } from 'zod'
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
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message, details: err.details ?? null }, { status: err.status })
      }
      if (err instanceof ZodError) {
        return Response.json({ error: 'Validation failed.', details: err.flatten() }, { status: 400 })
      }
      console.error('[unhandled route error]', err)
      return Response.json({ error: 'Something went wrong.' }, { status: 500 })
    }
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
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

export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('x-real-ip')
}
