import { prisma } from '@/lib/prisma'
import { SESSION_COOKIE } from '@/lib/session'
import { setMailer, type Mail, type Mailer } from '@/lib/mailer'

const BASE = 'http://localhost:3000'

export type RouteHandler<Ctx = unknown> = (req: Request, ctx: Ctx) => Promise<Response>

export type CallOptions<P> = {
  method?: string
  body?: unknown
  /** Raw session token; sent as the session cookie. */
  token?: string | null
  params?: P
  headers?: Record<string, string>
  query?: Record<string, string>
}

/**
 * Invokes a route handler the same way Next would, but without a server: a real
 * `Request` in, a real `Response` out. Every authorization path in the app is
 * therefore exercised exactly as deployed.
 */
export async function call<P = unknown>(
  handler: RouteHandler<{ params: Promise<P> }>,
  path: string,
  options: CallOptions<P> = {},
): Promise<{ status: number; body: any; text: string; setCookie: string | null; res: Response }> {
  const url = new URL(path, BASE)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value)
  }

  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  if (options.token) headers.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(options.token)}`)

  const req = new Request(url, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  const res = await handler(req, { params: Promise.resolve(options.params as P) })
  const text = await res.text()

  // Not every endpoint answers in JSON — exports are CSV, calendar feeds are
  // text/calendar. Parsing on content-type keeps `body` useful for the JSON routes
  // without turning a valid CSV response into a thrown SyntaxError.
  const isJson = (res.headers.get('content-type') ?? '').includes('json')

  return {
    status: res.status,
    body: isJson && text ? JSON.parse(text) : null,
    text,
    setCookie: res.headers.get('set-cookie'),
    res,
  }
}

/** Pulls the session token back out of a Set-Cookie header. */
export function tokenFromSetCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error('Expected a Set-Cookie header.')
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(setCookie)
  if (!match || !match[1]) throw new Error(`No ${SESSION_COOKIE} in: ${setCookie}`)
  return decodeURIComponent(match[1])
}

// ---------------------------------------------------------------------------
// Mail capture
// ---------------------------------------------------------------------------

export class CapturingMailer implements Mailer {
  readonly sent: Mail[] = []

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail)
  }

  last(): Mail {
    const mail = this.sent.at(-1)
    if (!mail) throw new Error('No mail was sent.')
    return mail
  }

  /** First URL in the most recent message — the reset or invite link. */
  lastLink(): string {
    const match = /https?:\/\/\S+/.exec(this.last().text)
    if (!match) throw new Error(`No link in mail body: ${this.last().text}`)
    return match[0]
  }

  tokenFromLastLink(): string {
    const token = new URL(this.lastLink()).searchParams.get('token')
    if (!token) throw new Error(`No token in link: ${this.lastLink()}`)
    return token
  }
}

export function useCapturingMailer(): CapturingMailer {
  const mailer = new CapturingMailer()
  setMailer(mailer)
  return mailer
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Wipes every table. Audit rows are append-only in the app, not in test setup. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditEvent", "Invitation", "PasswordResetToken", "Session",
                   "ScheduleVersion", "CalendarFeed", "NotificationPreference",
                   "GameOfficial", "Game", "BlackoutDate", "TimeSlot", "Field", "Venue",
                   "RefereeAvailability", "Referee", "TeamMembership", "PersonRelationship",
                   "Person", "Team", "Division", "Season", "League",
                   "Membership", "Organization", "User"
    RESTART IDENTITY CASCADE
  `)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { POST as signup } from '@/app/api/auth/signup/route'
import { POST as createOrg } from '@/app/api/orgs/route'
import { POST as invite } from '@/app/api/orgs/[orgId]/members/route'
import { POST as acceptInvite } from '@/app/api/invitations/accept/route'
import type { Role } from '@prisma/client'

export type TestUser = { id: string; email: string; token: string }

export async function signUp(
  email: string,
  password = 'correct-horse-battery',
  name = email.split('@')[0]!,
): Promise<TestUser> {
  const res = await call(signup, '/api/auth/signup', { body: { name, email, password } })
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`)
  return { id: res.body.user.id, email: res.body.user.email, token: tokenFromSetCookie(res.setCookie) }
}

export async function createOrganization(
  owner: TestUser,
  name = 'Riverside Youth Soccer',
): Promise<{ id: string; slug: string }> {
  const res = await call(createOrg, '/api/orgs', {
    token: owner.token,
    body: { name, timezone: 'America/Los_Angeles' },
  })
  if (res.status !== 201) throw new Error(`org create failed: ${JSON.stringify(res.body)}`)
  return { id: res.body.org.id, slug: res.body.org.slug }
}

/**
 * Full invite round trip: an admin invites `email` at `role`, the invitee accepts
 * with a brand-new account, and the resulting session token comes back.
 */
export async function inviteAndAccept(
  inviter: TestUser,
  orgId: string,
  email: string,
  role: Exclude<Role, 'owner'>,
  mailer: CapturingMailer,
): Promise<TestUser> {
  const inviteRes = await call<{ orgId: string }>(invite, `/api/orgs/${orgId}/members`, {
    token: inviter.token,
    params: { orgId },
    body: { email, role },
  })
  if (inviteRes.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inviteRes.body)}`)

  const token = mailer.tokenFromLastLink()
  const acceptRes = await call(acceptInvite, '/api/invitations/accept', {
    body: { token, name: email.split('@')[0], password: 'correct-horse-battery' },
  })
  if (acceptRes.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acceptRes.body)}`)

  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return { id: user.id, email, token: tokenFromSetCookie(acceptRes.setCookie) }
}

export async function membershipIdFor(orgId: string, userId: string): Promise<string> {
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_orgId: { userId, orgId } },
  })
  return membership.id
}

// ---------------------------------------------------------------------------
// Phase 2 fixtures
// ---------------------------------------------------------------------------

import { POST as createLeagueRoute } from '@/app/api/orgs/[orgId]/leagues/route'
import { POST as createSeasonRoute } from '@/app/api/orgs/[orgId]/seasons/route'
import { POST as createDivisionRoute } from '@/app/api/orgs/[orgId]/divisions/route'
import { POST as createTeamRoute } from '@/app/api/orgs/[orgId]/teams/route'
import { POST as createPersonRoute } from '@/app/api/orgs/[orgId]/people/route'
import { POST as addTeamMemberRoute } from '@/app/api/orgs/[orgId]/teams/[teamId]/members/route'
import { POST as createVenueRoute } from '@/app/api/orgs/[orgId]/venues/route'
import { POST as createFieldRoute } from '@/app/api/orgs/[orgId]/venues/[venueId]/fields/route'
import { POST as createTimeSlotRoute } from '@/app/api/orgs/[orgId]/fields/[fieldId]/timeslots/route'
import { POST as createRefereeRoute } from '@/app/api/orgs/[orgId]/referees/route'

/** Fails loudly with the server's message rather than a bare status code. */
function expectStatus(res: { status: number; body: any }, expected: number, what: string) {
  if (res.status !== expected) {
    throw new Error(`${what} expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`)
  }
}

export async function createLeague(actor: TestUser, orgId: string, name = 'Spring League') {
  const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${orgId}/leagues`, {
    token: actor.token,
    params: { orgId },
    body: { name, sport: 'soccer' },
  })
  expectStatus(res, 201, 'createLeague')
  return res.body.league as { id: string; name: string }
}

export async function createSeason(
  actor: TestUser,
  orgId: string,
  leagueId: string,
  overrides: { name?: string; startDate?: string; endDate?: string } = {},
) {
  const res = await call<{ orgId: string }>(createSeasonRoute, `/api/orgs/${orgId}/seasons`, {
    token: actor.token,
    params: { orgId },
    body: {
      leagueId,
      name: overrides.name ?? 'Spring 2026',
      startDate: overrides.startDate ?? '2026-03-07',
      endDate: overrides.endDate ?? '2026-05-30',
    },
  })
  expectStatus(res, 201, 'createSeason')
  return res.body.season as { id: string; name: string }
}

export async function createDivision(
  actor: TestUser,
  orgId: string,
  seasonId: string,
  name = 'U12 Boys',
) {
  const res = await call<{ orgId: string }>(createDivisionRoute, `/api/orgs/${orgId}/divisions`, {
    token: actor.token,
    params: { orgId },
    body: { seasonId, name },
  })
  expectStatus(res, 201, 'createDivision')
  return res.body.division as { id: string; name: string }
}

export async function createTeam(actor: TestUser, orgId: string, divisionId: string, name: string) {
  const res = await call<{ orgId: string }>(createTeamRoute, `/api/orgs/${orgId}/teams`, {
    token: actor.token,
    params: { orgId },
    body: { divisionId, name },
  })
  expectStatus(res, 201, `createTeam(${name})`)
  return res.body.team as { id: string; name: string }
}

export async function createPerson(
  actor: TestUser,
  orgId: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const res = await call<{ orgId: string }>(createPersonRoute, `/api/orgs/${orgId}/people`, {
    token: actor.token,
    params: { orgId },
    body: { name, ...extra },
  })
  expectStatus(res, 201, `createPerson(${name})`)
  return res.body.person as { id: string; name: string }
}

export async function addTeamMember(
  actor: TestUser,
  orgId: string,
  teamId: string,
  personId: string,
  role: 'player' | 'coach' | 'assistant' | 'manager' = 'player',
  extra: Record<string, unknown> = {},
) {
  const res = await call<{ orgId: string; teamId: string }>(
    addTeamMemberRoute,
    `/api/orgs/${orgId}/teams/${teamId}/members`,
    {
      token: actor.token,
      params: { orgId, teamId },
      body: { personId, role, ...extra },
    },
  )
  expectStatus(res, 201, 'addTeamMember')
  return res.body.member as { id: string }
}

export async function createVenue(
  actor: TestUser,
  orgId: string,
  name: string,
  timezone = 'America/Los_Angeles',
) {
  const res = await call<{ orgId: string }>(createVenueRoute, `/api/orgs/${orgId}/venues`, {
    token: actor.token,
    params: { orgId },
    body: { name, timezone },
  })
  expectStatus(res, 201, `createVenue(${name})`)
  return res.body.venue as { id: string; name: string; timezone: string }
}

export async function createField(actor: TestUser, orgId: string, venueId: string, name: string) {
  const res = await call<{ orgId: string; venueId: string }>(
    createFieldRoute,
    `/api/orgs/${orgId}/venues/${venueId}/fields`,
    { token: actor.token, params: { orgId, venueId }, body: { name } },
  )
  expectStatus(res, 201, `createField(${name})`)
  return res.body.field as { id: string; name: string }
}

export async function createRecurringSlot(
  actor: TestUser,
  orgId: string,
  fieldId: string,
  slot: { dayOfWeek: number; startTime: string; endTime: string; effectiveFrom?: string; effectiveTo?: string },
) {
  const res = await call<{ orgId: string; fieldId: string }>(
    createTimeSlotRoute,
    `/api/orgs/${orgId}/fields/${fieldId}/timeslots`,
    { token: actor.token, params: { orgId, fieldId }, body: { kind: 'recurring', ...slot } },
  )
  expectStatus(res, 201, 'createRecurringSlot')
  return res.body.timeSlot as { id: string }
}

export async function createReferee(
  actor: TestUser,
  orgId: string,
  personId: string,
  extra: Record<string, unknown> = {},
) {
  const res = await call<{ orgId: string }>(createRefereeRoute, `/api/orgs/${orgId}/referees`, {
    token: actor.token,
    params: { orgId },
    body: { personId, ...extra },
  })
  expectStatus(res, 201, 'createReferee')
  return res.body.referee as { id: string }
}
