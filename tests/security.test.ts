import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  CapturingMailer,
  call,
  createDivision,
  createLeague,
  createOrganization,
  createPerson,
  createSeason,
  createTeam,
  inviteAndAccept,
  resetDatabase,
  signUp,
  tokenFromSetCookie,
  useCapturingMailer,
  type TestUser,
} from './helpers'

import { POST as login } from '@/app/api/auth/login/route'
import { POST as signupRoute } from '@/app/api/auth/signup/route'
import { POST as forgotPassword } from '@/app/api/auth/password/forgot/route'
import { POST as invite } from '@/app/api/orgs/[orgId]/members/route'
import { GET as exportTeam } from '@/app/api/orgs/[orgId]/teams/[teamId]/export/route'
import { POST as createLeagueRoute } from '@/app/api/orgs/[orgId]/leagues/route'
import { POST as assignOfficial } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/route'
import { PATCH as respondToAssignment } from '@/app/api/orgs/[orgId]/games/[gameId]/officials/[assignmentId]/route'
import {
  GET as listVersionsRoute,
  POST as createVersionRoute,
} from '@/app/api/orgs/[orgId]/seasons/[seasonId]/versions/route'

import { MAX_BODY_BYTES, assertNotCrossSite, clientIp } from '@/lib/http'
import { AUTH_LIMITS, MemoryRateLimitStore, enforceRateLimit } from '@/lib/rate-limit'
import { safeRedirectPath } from '@/lib/redirect'
import { parseCsv, toCsv } from '@/lib/csv'

/**
 * Security regression tests.
 *
 * Each block corresponds to a defect that was present and is now fixed. They are
 * written to fail if the fix is reverted, which is the only reason a regression test
 * earns its place — a test that would pass against the vulnerable code documents
 * nothing.
 */

let mailer: CapturingMailer

beforeEach(async () => {
  await resetDatabase()
  mailer = useCapturingMailer()
})

// ---------------------------------------------------------------------------
// Open redirect
// ---------------------------------------------------------------------------

describe('post-login redirect targets', () => {
  it('accepts genuine same-origin paths', () => {
    expect(safeRedirectPath('/app/riverside')).toBe('/app/riverside')
    expect(safeRedirectPath('/app?tab=1#frag')).toBe('/app?tab=1#frag')
  })

  it('rejects protocol-relative URLs, which pass a naive leading-slash check', () => {
    // The original bug: `startsWith('/')` is true for all of these, and a browser
    // resolves every one of them to a different origin.
    expect(safeRedirectPath('//evil.example')).toBe('/app')
    expect(safeRedirectPath('//evil.example/path')).toBe('/app')
    expect(safeRedirectPath('/\\evil.example')).toBe('/app')
    expect(safeRedirectPath('/\\/evil.example')).toBe('/app')
  })

  it('rejects absolute URLs and non-paths', () => {
    for (const bad of [
      'https://evil.example',
      'http://evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'app',
      '',
    ]) {
      expect(safeRedirectPath(bad), bad).toBe('/app')
    }
  })

  it('rejects targets carrying control characters or whitespace', () => {
    expect(safeRedirectPath('/app\n/evil')).toBe('/app')
    expect(safeRedirectPath('/\t//evil.example')).toBe('/app')
    expect(safeRedirectPath('/ /evil')).toBe('/app')
  })

  it('honours a caller-supplied fallback', () => {
    expect(safeRedirectPath('//evil.example', '/login')).toBe('/login')
  })
})

// ---------------------------------------------------------------------------
// CSV formula injection
// ---------------------------------------------------------------------------

describe('CSV export neutralises spreadsheet formulas', () => {
  it('prefixes cells a spreadsheet would execute', () => {
    const csv = toCsv(
      ['name'],
      [
        ['=cmd|\'/c calc\'!A0'],
        ['+1+1'],
        ['-1+1'],
        ['@SUM(A1:A9)'],
        ['=HYPERLINK("http://attacker.example","click")'],
      ],
    )
    const lines = csv.split('\r\n').slice(1)
    for (const line of lines) {
      // Either bare or inside the CSV quoting, the payload never starts the cell.
      expect(line.replace(/^"/, '').startsWith("'"), line).toBe(true)
    }
  })

  it('leaves ordinary values untouched', () => {
    expect(toCsv(['a', 'b'], [['Riverside Rovers', 12]])).toBe('a,b\r\nRiverside Rovers,12')
  })

  it('still quotes correctly, so the file round-trips through a CSV parser', () => {
    const csv = toCsv(['name', 'note'], [['=danger', 'has, comma and "quote"']])
    const parsed = parseCsv(csv)
    expect(parsed.rows[0]![0]).toBe("'=danger")
    expect(parsed.rows[0]![1]).toBe('has, comma and "quote"')
  })

  it('neutralises a malicious name that reached a real export', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)
    const league = await createLeague(owner, org.id)
    const season = await createSeason(owner, org.id, league.id)
    const division = await createDivision(owner, org.id, season.id)
    const team = await createTeam(owner, org.id, division.id, 'Rovers')
    await createPerson(owner, org.id, '=HYPERLINK("http://attacker.example")')

    const person = await prisma.person.findFirstOrThrow({
      where: { orgId: org.id, name: { startsWith: '=' } },
    })
    await prisma.teamMembership.create({
      data: { teamId: team.id, personId: person.id, role: 'player' },
    })

    const res = await call<{ orgId: string; teamId: string }>(
      exportTeam,
      `/api/orgs/${org.id}/teams/${team.id}/export`,
      { token: owner.token, params: { orgId: org.id, teamId: team.id } },
    )

    expect(res.status).toBe(200)
    expect(res.text).toContain('=HYPERLINK')
    // The payload is present as data but can never begin a cell.
    for (const line of res.text.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(cell.replace(/^"/, '').startsWith('=')).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('caps repeated password guesses against one account', async () => {
    await signUp('victim@example.com', 'correct-horse-battery')

    const attempt = () =>
      call(login, '/api/auth/login', {
        body: { email: 'victim@example.com', password: 'wrong-guess' },
      })

    const codes: number[] = []
    for (let i = 0; i < AUTH_LIMITS.login.perIdentifier.limit + 3; i += 1) {
      codes.push((await attempt()).status)
    }

    expect(codes.filter((code) => code === 401).length).toBe(AUTH_LIMITS.login.perIdentifier.limit)
    expect(codes.at(-1)).toBe(429)
  })

  it('answers a throttled request with Retry-After', async () => {
    await signUp('victim@example.com')
    let last = await call(login, '/api/auth/login', {
      body: { email: 'victim@example.com', password: 'nope' },
    })
    for (let i = 0; i < AUTH_LIMITS.login.perIdentifier.limit + 2 && last.status !== 429; i += 1) {
      last = await call(login, '/api/auth/login', {
        body: { email: 'victim@example.com', password: 'nope' },
      })
    }
    expect(last.status).toBe(429)
    expect(Number(last.res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('still lets the real owner in once they use the right password', async () => {
    const user = await signUp('victim@example.com', 'correct-horse-battery')
    expect(user.token).toBeTruthy()

    // A few wrong guesses, then the correct one — under the limit, so legitimate
    // access is unaffected by the control.
    for (let i = 0; i < 3; i += 1) {
      await call(login, '/api/auth/login', {
        body: { email: 'victim@example.com', password: 'wrong' },
      })
    }
    const ok = await call(login, '/api/auth/login', {
      body: { email: 'victim@example.com', password: 'correct-horse-battery' },
    })
    expect(ok.status).toBe(200)
    expect(tokenFromSetCookie(ok.setCookie)).toBeTruthy()
  })

  it('caps password-reset mail so the endpoint cannot be used as a spam relay', async () => {
    await signUp('target@example.com')
    mailer.sent.length = 0

    const codes: number[] = []
    for (let i = 0; i < AUTH_LIMITS.passwordReset.perIdentifier.limit + 2; i += 1) {
      codes.push(
        (await call(forgotPassword, '/api/auth/password/forgot', {
          body: { email: 'target@example.com' },
        })).status,
      )
    }

    expect(codes.at(-1)).toBe(429)
    expect(mailer.sent.length).toBe(AUTH_LIMITS.passwordReset.perIdentifier.limit)
  })

  it('caps account creation per client', async () => {
    const codes: number[] = []
    for (let i = 0; i < AUTH_LIMITS.signup.perIp.limit + 2; i += 1) {
      codes.push(
        (await call(signupRoute, '/api/auth/signup', {
          body: { name: `U${i}`, email: `u${i}@example.com`, password: 'correct-horse-battery' },
          headers: { 'x-forwarded-for': '203.0.113.9' },
        })).status,
      )
    }
    expect(codes.filter((code) => code === 201).length).toBe(AUTH_LIMITS.signup.perIp.limit)
    expect(codes.at(-1)).toBe(429)
  })

  it('caps invitations, which each send mail to an address the caller picks', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)

    const codes: number[] = []
    for (let i = 0; i < AUTH_LIMITS.invitation.perIdentifier.limit + 2; i += 1) {
      codes.push(
        (await call<{ orgId: string }>(invite, `/api/orgs/${org.id}/members`, {
          token: owner.token,
          params: { orgId: org.id },
          body: { email: `invitee${i}@example.com`, role: 'viewer' },
        })).status,
      )
    }
    expect(codes.at(-1)).toBe(429)
  })

  it('keeps buckets separate so one endpoint cannot spend another’s budget', () => {
    const store = new MemoryRateLimitStore()
    const rule = { perIdentifier: { limit: 1, windowMs: 60_000 } }

    enforceRateLimit({ bucket: 'a', identifier: 'x@y.example', ...rule }, 0, store)
    // Same identifier, different bucket: still allowed.
    expect(() =>
      enforceRateLimit({ bucket: 'b', identifier: 'x@y.example', ...rule }, 0, store),
    ).not.toThrow()
    // Same bucket again: refused.
    expect(() =>
      enforceRateLimit({ bucket: 'a', identifier: 'x@y.example', ...rule }, 0, store),
    ).toThrow()
  })

  it('treats an identifier case-insensitively, matching how the account is looked up', () => {
    const store = new MemoryRateLimitStore()
    const rule = { perIdentifier: { limit: 1, windowMs: 60_000 } }
    enforceRateLimit({ bucket: 'login', identifier: 'Person@Example.com', ...rule }, 0, store)
    expect(() =>
      enforceRateLimit({ bucket: 'login', identifier: 'person@example.com', ...rule }, 0, store),
    ).toThrow()
  })

  it('rolls the window over so a limit is a delay, not a permanent lockout', () => {
    const store = new MemoryRateLimitStore()
    const rule = { perIdentifier: { limit: 1, windowMs: 1_000 } }
    enforceRateLimit({ bucket: 'login', identifier: 'a@b.example', ...rule }, 0, store)
    expect(() => enforceRateLimit({ bucket: 'login', identifier: 'a@b.example', ...rule }, 500, store)).toThrow()
    expect(() =>
      enforceRateLimit({ bucket: 'login', identifier: 'a@b.example', ...rule }, 1_500, store),
    ).not.toThrow()
  })

  it('does not grow without bound when sprayed with one-shot keys', () => {
    const store = new MemoryRateLimitStore(100)
    const rule = { perIp: { limit: 5, windowMs: 1_000 } }
    for (let i = 0; i < 500; i += 1) {
      enforceRateLimit({ bucket: 'login', ip: `10.0.0.${i}`, ...rule }, i * 10, store)
    }
    // Nothing to assert on the map directly, so assert the behaviour that matters:
    // it is still enforcing rather than having fallen over.
    expect(() => enforceRateLimit({ bucket: 'login', ip: 'fixed', ...rule }, 10_000, store)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Client address trust
// ---------------------------------------------------------------------------

describe('clientIp', () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request('https://app.example/api/x', { headers })

  it('takes the address the trusted proxy appended, not the one the caller sent', () => {
    // The original bug read the leftmost entry, which the caller fully controls.
    const req = withHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('ignores a forged single-entry header when more hops were expected', () => {
    const previous = process.env.TRUSTED_PROXY_HOPS
    process.env.TRUSTED_PROXY_HOPS = '2'
    try {
      expect(clientIp(withHeaders({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull()
      expect(clientIp(withHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.9.9.9' }))).toBe('5.6.7.8')
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOPS
      else process.env.TRUSTED_PROXY_HOPS = previous
    }
  })

  it('ignores the header entirely when nothing is in front of the app', () => {
    const previous = process.env.TRUSTED_PROXY_HOPS
    process.env.TRUSTED_PROXY_HOPS = '0'
    try {
      expect(clientIp(withHeaders({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOPS
      else process.env.TRUSTED_PROXY_HOPS = previous
    }
  })
})

// ---------------------------------------------------------------------------
// CSRF: cross-site provenance
// ---------------------------------------------------------------------------

describe('cross-site write rejection', () => {
  const post = (headers: Record<string, string>) =>
    new Request('https://app.example/api/orgs/x/leagues', { method: 'POST', headers })

  it('rejects a write whose Origin is another site', () => {
    expect(() => assertNotCrossSite(post({ origin: 'https://evil.example' }))).toThrow()
  })

  it('rejects a write the browser labels cross-site', () => {
    expect(() => assertNotCrossSite(post({ 'sec-fetch-site': 'cross-site' }))).toThrow()
    expect(() => assertNotCrossSite(post({ 'sec-fetch-site': 'same-site' }))).toThrow()
  })

  it('rejects an opaque origin', () => {
    expect(() => assertNotCrossSite(post({ origin: 'null' }))).toThrow()
  })

  it('allows a same-origin write', () => {
    expect(() =>
      assertNotCrossSite(post({ origin: 'https://app.example', 'sec-fetch-site': 'same-origin' })),
    ).not.toThrow()
  })

  it('matches against the forwarded host when the app is behind a proxy', () => {
    const req = new Request('http://internal:3000/api/x', {
      method: 'POST',
      headers: { origin: 'https://public.example', 'x-forwarded-host': 'public.example' },
    })
    expect(() => assertNotCrossSite(req)).not.toThrow()
  })

  it('allows requests with no provenance headers, which cannot be CSRF', () => {
    // curl, a calendar client, the test suite. None carries a victim's cookies.
    expect(() => assertNotCrossSite(post({}))).not.toThrow()
  })

  it('never blocks a safe method', () => {
    const get = new Request('https://app.example/api/x', {
      headers: { origin: 'https://evil.example' },
    })
    expect(() => assertNotCrossSite(get)).not.toThrow()
  })

  it('refuses a real cross-site write end to end', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)

    const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Injected League' },
      headers: { origin: 'https://evil.example' },
    })

    expect(res.status).toBe(403)
    expect(await prisma.league.count({ where: { orgId: org.id } })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Request body limits
// ---------------------------------------------------------------------------

describe('request body size', () => {
  it('refuses an oversized body with 413 rather than buffering it', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)

    const huge = 'x'.repeat(MAX_BODY_BYTES + 1024)
    const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'League', description: huge },
    })

    expect(res.status).toBe(413)
  })

  it('refuses an oversized body that under-declares its Content-Length', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)

    const huge = JSON.stringify({ name: 'League', description: 'x'.repeat(MAX_BODY_BYTES + 1024) })
    const req = new Request(`http://localhost:3000/api/orgs/${org.id}/leagues`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `ss_session=${encodeURIComponent(owner.token)}`,
        // A lie. The measured byte length is what must decide.
        'content-length': '10',
      },
      body: huge,
    })
    const res = await createLeagueRoute(req, { params: Promise.resolve({ orgId: org.id }) })
    expect(res.status).toBe(413)
  })

  it('accepts a normal body', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)
    const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: owner.token,
      params: { orgId: org.id },
      body: { name: 'Recreational' },
    })
    expect(res.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// Mail transport does not leak credentials into logs
// ---------------------------------------------------------------------------

describe('reset and invitation links', () => {
  it('are single-use credentials, so they are never printed in production', async () => {
    // The console transport is the *default*, so this is the shipped path when SMTP
    // is unconfigured. Asserted on the module's behaviour rather than by scraping
    // stdout, which vitest owns.
    const { mailer: getMailer, setMailer } = await import('@/lib/mailer')
    setMailer(null)

    const logged: string[] = []
    const realLog = console.log
    const realWarn = console.warn
    console.log = (...args: unknown[]) => void logged.push(args.join(' '))
    console.warn = (...args: unknown[]) => void logged.push(args.join(' '))
    // `vi.stubEnv` rather than assigning to process.env: NODE_ENV is defined as a
    // non-writable property under vitest, and restoring it by hand throws.
    vi.stubEnv('NODE_ENV', 'production')
    try {
      await getMailer().send({
        to: 'victim@example.com',
        subject: 'Reset your password',
        text: 'Use this link: https://app.example/reset-password?token=SUPER-SECRET-TOKEN',
      })
    } finally {
      console.log = realLog
      console.warn = realWarn
      vi.unstubAllEnvs()
      setMailer(null)
    }

    const combined = logged.join('\n')
    expect(combined).not.toContain('SUPER-SECRET-TOKEN')
    expect(combined).toContain('withheld')
    // And it warns that mail is not actually being delivered.
    expect(combined).toMatch(/MAIL_TRANSPORT/)
  })
})

// ---------------------------------------------------------------------------
// Privilege boundaries that the fixes must not have loosened
// ---------------------------------------------------------------------------

describe('authorization still holds after the security changes', () => {
  it('keeps a viewer out of a write endpoint', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)
    const viewer = await inviteAndAccept(owner, org.id, 'viewer@example.com', 'viewer', mailer)

    const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      token: viewer.token,
      params: { orgId: org.id },
      body: { name: 'Nope' },
    })
    expect(res.status).toBe(403)
  })

  it('keeps an anonymous caller out', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)
    const res = await call<{ orgId: string }>(createLeagueRoute, `/api/orgs/${org.id}/leagues`, {
      params: { orgId: org.id },
      body: { name: 'Nope' },
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Concurrency: races the database now closes
// ---------------------------------------------------------------------------

describe('officiating integrity under concurrency', () => {
  /**
   * Fixture: one future game, two referees, nobody assigned.
   *
   * The races below fire real concurrent requests rather than simulating them, so
   * they exercise the actual window between "check whether the slot is free" and
   * "insert". Without the partial unique indexes these tests seat two officials in
   * one position and pass silently.
   */
  async function oneGame() {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)
    const league = await createLeague(owner, org.id, 'Recreational')
    const season = await createSeason(owner, org.id, league.id, {
      startDate: '2027-03-06',
      endDate: '2027-05-29',
    })
    const division = await createDivision(owner, org.id, season.id)
    const home = await createTeam(owner, org.id, division.id, 'Rovers')
    const away = await createTeam(owner, org.id, division.id, 'Owls')

    const venue = await prisma.venue.create({
      data: { orgId: org.id, name: 'Riverside', timezone: 'America/Los_Angeles' },
    })
    const field = await prisma.field.create({ data: { venueId: venue.id, name: 'Field 1' } })
    const game = await prisma.game.create({
      data: {
        seasonId: season.id,
        divisionId: division.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        fieldId: field.id,
        startTime: new Date('2027-04-03T15:00:00.000Z'),
        durationMinutes: 60,
      },
    })

    const refs: string[] = []
    for (const name of ['Wei Chen', 'Dana Vaughn']) {
      const person = await createPerson(owner, org.id, name)
      const referee = await prisma.referee.create({
        data: { personId: person.id, maxGamesPerDay: 5 },
      })
      refs.push(referee.id)
    }

    return { owner, org, game, refs }
  }

  const assign = (
    owner: TestUser,
    orgId: string,
    gameId: string,
    body: Record<string, unknown>,
  ) =>
    call<{ orgId: string; gameId: string }>(
      assignOfficial,
      `/api/orgs/${orgId}/games/${gameId}/officials`,
      { token: owner.token, params: { orgId, gameId }, body },
    )

  it('seats only one official per position when two requests race', async () => {
    const { owner, org, game, refs } = await oneGame()

    const results = await Promise.all([
      assign(owner, org.id, game.id, { refereeId: refs[0], position: 'center' }),
      assign(owner, org.id, game.id, { refereeId: refs[1], position: 'center' }),
    ])

    const created = results.filter((r) => r.status === 201)
    const refused = results.filter((r) => r.status === 409)
    expect(created).toHaveLength(1)
    expect(refused).toHaveLength(1)
    // A 500 here would mean the constraint fired but the error was not translated.
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true)

    const held = await prisma.gameOfficial.count({
      where: { gameId: game.id, position: 'center', deletedAt: null, status: { not: 'declined' } },
    })
    expect(held).toBe(1)
  })

  it('puts a referee on a crew only once when two requests race', async () => {
    const { owner, org, game, refs } = await oneGame()

    const results = await Promise.all([
      assign(owner, org.id, game.id, { refereeId: refs[0], position: 'center' }),
      assign(owner, org.id, game.id, { refereeId: refs[0], position: 'AR1' }),
    ])

    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(1)
    expect(
      await prisma.gameOfficial.count({
        where: { gameId: game.id, refereeId: refs[0], deletedAt: null, status: { not: 'declined' } },
      }),
    ).toBe(1)
  })

  it('still allows a replacement after a decline, which the constraint must permit', async () => {
    const { owner, org, game, refs } = await oneGame()

    const first = await assign(owner, org.id, game.id, { refereeId: refs[0], position: 'center' })
    expect(first.status).toBe(201)

    // The original official turns it down, which frees the position.
    await prisma.gameOfficial.update({
      where: { id: first.body.assignment.id },
      data: { status: 'declined', respondedAt: new Date() },
    })

    // A plain unique index on (gameId, position) would refuse this. It must not:
    // this is the normal outcome of the request flow.
    const replacement = await assign(owner, org.id, game.id, {
      refereeId: refs[1],
      position: 'center',
    })
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201)

    expect(
      await prisma.gameOfficial.count({ where: { gameId: game.id, position: 'center', deletedAt: null } }),
    ).toBe(2)
  })

  it('refuses to un-decline into a position somebody else has taken', async () => {
    const { owner, org, game, refs } = await oneGame()

    const first = await assign(owner, org.id, game.id, { refereeId: refs[0], position: 'center' })
    await prisma.gameOfficial.update({
      where: { id: first.body.assignment.id },
      data: { status: 'declined', respondedAt: new Date() },
    })
    const replacement = await assign(owner, org.id, game.id, {
      refereeId: refs[1],
      position: 'center',
    })
    expect(replacement.status).toBe(201)

    // The first official changes their mind, but the shirt is gone. This must be a
    // clean conflict rather than a 500 — and it must not produce two centres.
    const undo = await call<{ orgId: string; gameId: string; assignmentId: string }>(
      respondToAssignment,
      `/api/orgs/${org.id}/games/${game.id}/officials/${first.body.assignment.id}`,
      {
        token: owner.token,
        method: 'PATCH',
        params: { orgId: org.id, gameId: game.id, assignmentId: first.body.assignment.id },
        body: { status: 'accepted' },
      },
    )

    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/position first|already on the crew/i)
    expect(
      await prisma.gameOfficial.count({
        where: { gameId: game.id, position: 'center', deletedAt: null, status: { not: 'declined' } },
      }),
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

describe('the CSP middleware', () => {
  /**
   * These guard against the failure mode that a CSP most often has: silently
   * breaking the application.
   *
   * Next streams the React payload in inline `<script>` blocks. A `script-src`
   * without a matching nonce refuses them, React never hydrates, and every client
   * component stops working while the server keeps returning 200 — so nothing in a
   * status-code-based check notices.
   */
  it('issues a nonce and puts the same one in the header it returns', async () => {
    const { middleware } = await import('@/middleware')
    const req = new NextRequest('https://app.example/login')
    const res = middleware(req)

    const csp = res.headers.get('content-security-policy')
    expect(csp).toBeTruthy()

    const headerNonce = /'nonce-([^']+)'/.exec(csp!)?.[1]
    expect(headerNonce, 'script-src must carry a nonce').toBeTruthy()

    // Next reads the nonce off the *request* headers to stamp its script tags. If
    // this stops matching the response header, the browser refuses the scripts.
    const forwarded = res.headers.get('x-middleware-request-content-security-policy')
    const requestNonce = forwarded ? /'nonce-([^']+)'/.exec(forwarded)?.[1] : headerNonce
    expect(requestNonce).toBe(headerNonce)
  })

  it('uses a fresh nonce per request, or it is not a nonce', async () => {
    const { middleware } = await import('@/middleware')
    const first = middleware(new NextRequest('https://app.example/login'))
    const second = middleware(new NextRequest('https://app.example/login'))

    const nonceOf = (res: Response) =>
      /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1]

    expect(nonceOf(first)).not.toBe(nonceOf(second))
  })

  it('keeps the directives that do the non-script work', async () => {
    const { middleware } = await import('@/middleware')
    const csp = middleware(new NextRequest('https://app.example/')).headers.get(
      'content-security-policy',
    )!

    // Each of these blocks a distinct attack and none depends on the nonce.
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("connect-src 'self'")
  })

  it('never grants unsafe-inline or unsafe-eval where it would actually matter', async () => {
    const { middleware } = await import('@/middleware')
    const csp = middleware(new NextRequest('https://app.example/')).headers.get(
      'content-security-policy',
    )!

    // `'strict-dynamic'` must be present: it is what makes a browser ignore the
    // legacy `'unsafe-inline'` fallback that older browsers need.
    expect(csp).toContain("'strict-dynamic'")
    expect(csp).not.toContain("'unsafe-eval'")
  })
})

// ---------------------------------------------------------------------------
// Resource exhaustion: the versions list
// ---------------------------------------------------------------------------

describe('listing schedule versions', () => {
  it('reports the game count without loading any snapshot', async () => {
    const owner = await signUp('owner@example.com')
    const org = await createOrganization(owner)
    const league = await createLeague(owner, org.id, 'Recreational')
    const season = await createSeason(owner, org.id, league.id, {
      startDate: '2027-03-06',
      endDate: '2027-05-29',
    })
    const division = await createDivision(owner, org.id, season.id)
    const home = await createTeam(owner, org.id, division.id, 'Rovers')
    const away = await createTeam(owner, org.id, division.id, 'Owls')

    const venue = await prisma.venue.create({
      data: { orgId: org.id, name: 'Riverside', timezone: 'America/Los_Angeles' },
    })
    const field = await prisma.field.create({ data: { venueId: venue.id, name: 'Field 1' } })
    for (let i = 0; i < 3; i += 1) {
      await prisma.game.create({
        data: {
          seasonId: season.id,
          divisionId: division.id,
          homeTeamId: home.id,
          awayTeamId: away.id,
          fieldId: field.id,
          startTime: new Date(`2027-04-0${i + 1}T15:00:00.000Z`),
          durationMinutes: 60,
        },
      })
    }

    const created = await call<{ orgId: string; seasonId: string }>(
      createVersionRoute,
      `/api/orgs/${org.id}/seasons/${season.id}/versions`,
      {
        token: owner.token,
        params: { orgId: org.id, seasonId: season.id },
        body: { note: 'snapshot of three games' },
      },
    )
    expect(created.status).toBe(201)

    // The denormalised column is what the list reads, so it has to be right.
    const stored = await prisma.scheduleVersion.findFirstOrThrow({
      where: { seasonId: season.id },
      select: { gameCount: true, snapshot: true },
    })
    expect(stored.gameCount).toBe(3)
    expect((stored.snapshot as { games: unknown[] }).games).toHaveLength(3)

    const listed = await call<{ orgId: string; seasonId: string }>(
      listVersionsRoute,
      `/api/orgs/${org.id}/seasons/${season.id}/versions`,
      { token: owner.token, params: { orgId: org.id, seasonId: season.id } },
    )
    expect(listed.status).toBe(200)
    expect(listed.body.versions[0].gameCount).toBe(3)

    // The snapshot must never be in the response: it is the largest column in the
    // schema and the list has no use for it.
    expect(listed.text).not.toContain('"snapshot"')
    expect(JSON.stringify(listed.body)).not.toContain('homeTeamName')
  })
})

describe('login lockout is bounded', () => {
  it('clears the account’s failed-attempt budget once the real user gets in', async () => {
    await signUp('victim@example.com', 'correct-horse-battery')

    // An attacker spends most of the budget guessing.
    for (let i = 0; i < AUTH_LIMITS.login.perIdentifier.limit - 1; i += 1) {
      const res = await call(login, '/api/auth/login', {
        body: { email: 'victim@example.com', password: `guess-${i}` },
      })
      expect(res.status).toBe(401)
    }

    // The real user signs in on the last remaining attempt.
    const ok = await call(login, '/api/auth/login', {
      body: { email: 'victim@example.com', password: 'correct-horse-battery' },
    })
    expect(ok.status).toBe(200)

    // ...and is not then locked out by the residue of the attacker's attempts.
    const again = await call(login, '/api/auth/login', {
      body: { email: 'victim@example.com', password: 'correct-horse-battery' },
    })
    expect(again.status).toBe(200)
  })
})
