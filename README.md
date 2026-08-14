# Sports Scheduler

League scheduling for any sport: define teams, people, venues, officials and rules,
generate a season schedule that respects every hard constraint, then review,
publish and roll back with a full audit trail.

**Status: complete.** All six phases are in: auth and accounts, the core data model
with its CRUD surface and conflict checking, the scheduling engine, revision history,
the editing UI, and import/export/notifications.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript strict |
| Database | PostgreSQL 16 via Prisma |
| Styling | Tailwind CSS v4 |
| Passwords | argon2id (`@node-rs/argon2`) |
| Sessions | opaque bearer tokens in an `HttpOnly` cookie, SHA-256 hashed at rest |
| Tests | Vitest, running against a real Postgres database |

## Setup

Requires Node 20+ and a PostgreSQL 14+ server.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL / TEST_DATABASE_URL
createdb scheduler
createdb scheduler_test       # only needed for `npm test`

npm run db:migrate            # apply migrations
npm run seed                  # demo organization with a user at every role
npm run dev                   # http://localhost:3000
```

### Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `TEST_DATABASE_URL` | separate database for `npm test`; **its tables are truncated** |
| `APP_URL` | absolute origin used to build invitation and reset links |
| `SESSION_TTL_DAYS` | session cookie lifetime (default 30) |
| `MAIL_TRANSPORT` | `console` writes messages to `.mail/`; `smtp` sends via `SMTP_URL` |
| `MAIL_FROM`, `SMTP_URL` | outbound mail settings when `MAIL_TRANSPORT=smtp` |

With `MAIL_TRANSPORT=console` no mail server is needed: invitation and
password-reset messages are written to `.mail/` and their links logged to stdout,
so the full flows are exercisable locally.

### Demo accounts

`npm run seed` creates **Riverside Youth Soccer**: 2 leagues, an active season with a
9-team U12 Boys division (odd on purpose, so bye handling gets exercised) and an
8-team U10 Girls division, 233 people on full rosters, 10 officials with weekly
availability and blackouts, 2 venues over 3 fields with Saturday 8am–6pm and Sunday
1–5pm local slots, holiday and maintenance blackouts, a sibling pair split across two
teams, and one user per role.

That is deliberately the shape acceptance scenario 2 asks for, so the phase 3
generator can run against it with no extra setup.

**The season is anchored to the current week**, spanning roughly five weeks back to
nine weeks ahead, so a freshly seeded org always has games behind it and fixtures in
front of it. Fixed dates rot: a season that finished months ago leaves every "next
game" panel empty, which makes a working app look broken. The seed prints the window
it chose. This does not weaken idempotent generation — the engine still returns the
same schedule for the same config and seed; it is the config that follows the
calendar.

`npm run demo:openings` frees a few officiating positions afterwards. It exists
because the generator fills every available official to their daily cap, so
immediately after generating there is nothing anybody can volunteer for — measured
against the seeded org, *every* unstaffed game was blocked for the demo referee by
their cap or their availability. Somebody declining is the situation the request flow
is actually for, so the script arranges a handful of declines on days the demo referee
still has room.

Password for all logins is `demo-password-123`:

| Role | Email |
| --- | --- |
| owner | `owner@riverside.example` |
| admin | `admin@riverside.example` |
| scheduler | `scheduler@riverside.example` |
| coach | `coach@riverside.example` |
| referee | `referee@riverside.example` |
| viewer | `viewer@riverside.example` |

The seed script is idempotent — re-running soft-deletes the previous set rather than
dropping it, so the audit trail survives — and prints a live invitation-accept link
each run.

## Seeing it running

**Actions → Preview → Run workflow** gives you a public HTTPS URL in about four
minutes and needs no credentials at all. The workflow runs the real app inside the
runner — Postgres as a service container, seeded, with a schedule generated and
published — and tunnels it out. The run summary carries the URL and the demo logins,
so it works from a phone. The URL is disposable: it changes every run and dies with
the job.

For a URL that persists, see [DEPLOYMENT.md](DEPLOYMENT.md). Short version: add a
`DATABASE_URL` and a `VERCEL_TOKEN` to the repository's Actions secrets, then run the
**Deploy** workflow. It applies migrations, builds, deploys, and polls the resulting
URL until it answers 200 — so a green run means the app is up, not just that the
upload worked.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` / `npm start` | production build and serve |
| `npm test` | Vitest suite (migrates `TEST_DATABASE_URL` first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | create/apply a dev migration |
| `npm run db:deploy` | apply migrations (production) |
| `npm run db:reset` | drop, re-migrate and re-seed |
| `npm run seed` | seed demo data |
| `npm run demo:openings` | free a few officiating slots in the demo data, so the request flow has something to act on |

## Security controls

Authorization is the big one and has its own section below. These are the rest, with
the reasoning, because a header list without reasoning is how a policy gets copied
somewhere it breaks something.

| Control | Where | Note |
| --- | --- | --- |
| Rate limiting | [`src/lib/rate-limit.ts`](src/lib/rate-limit.ts) | Login, signup, password reset, token submission and invitations. Two axes — per account and per client — because each catches what the other misses. Applied **before** argon2 runs, so the deliberately expensive KDF is not itself a denial-of-service lever. |
| CSRF | `assertNotCrossSite` in [`src/lib/http.ts`](src/lib/http.ts) | `SameSite=Lax` is the primary control; this is the second layer. Only *contradicted* provenance is rejected, never missing provenance — curl and calendar clients carry no ambient cookies and so cannot be a CSRF vector. |
| CSP with a nonce | [`src/middleware.ts`](src/middleware.ts) | Per-request nonce rather than `'unsafe-inline'`. A static `script-src 'self'` looks stricter and silently breaks the app: Next streams React's payload in inline `<script>` blocks, so without a nonce nothing hydrates and every client component dies while the server still returns 200. |
| Other headers | [`next.config.ts`](next.config.ts) | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` (reset and invitation tokens ride in query strings — never send them cross-origin), a closed `Permissions-Policy`, and HSTS in production only. `X-Powered-By` removed. |
| Body size limit | `MAX_BODY_BYTES` in [`src/lib/http.ts`](src/lib/http.ts) | 2 MB, enforced on measured bytes rather than the `Content-Length` a caller claims. Without it `req.json()` buffers whatever it is sent before any schema sees it. |
| Open-redirect defence | [`src/lib/redirect.ts`](src/lib/redirect.ts) | One definition shared by the server page and the client form. `startsWith('/')` is not enough: `//evil.example` is protocol-relative and every browser resolves it off-origin. |
| CSV formula neutralisation | `toCsv` in [`src/lib/csv.ts`](src/lib/csv.ts) | Team and person names reach exports and are user-controlled. A cell beginning `=`, `+`, `-` or `@` executes in Excel, Sheets and LibreOffice, so every cell is guarded at the point of rendering. |
| Client-address trust | `clientIp` in [`src/lib/http.ts`](src/lib/http.ts) | `X-Forwarded-For` is read from the **right**, the end your own proxy wrote, `TRUSTED_PROXY_HOPS` places from the end. The leftmost entry is attacker-chosen; believing it lets anyone write arbitrary values into audit rows and vary a header to defeat per-IP limits. |
| Mail transport | [`src/lib/mailer.ts`](src/lib/mailer.ts) | The development transport never prints reset or invitation links in production — each is a single-use credential — writes `.mail/` at `0700`/`0600`, and warns loudly that mail is not reaching anyone. |
| Race safety | `20260814210000` / `20260814200000` migrations | Partial unique indexes on the officiating tables. The application could only narrow these races, not close them: a read-then-insert lets two concurrent requests both seat a centre official. A `P2002` is translated to a 409 in `handler` so the loser gets a real answer. |

Passwords are argon2id at OWASP's suggested interactive parameters, capped at 200
characters so the KDF cannot be fed a megabyte. Session tokens are 256 random bits
stored as SHA-256 digests. Prisma is never configured to log queries, so parameters —
which include password hashes — stay out of logs.

Two deliberate, documented trade-offs rather than oversights:

- **Signup says when an address is already registered.** That is account enumeration,
  and the alternative — accepting the signup and sending an email instead — makes the
  flow unusable for the sort of organization this is for. Bulk enumeration is capped
  by the signup rate limit; login and password reset are both non-enumerable.
- **Rate limiting is in-process.** With more than one server process each keeps its own
  counters, so the effective limit multiplies by the process count. It is still the
  difference between thousands of guesses a minute and a handful, and
  `createRateLimiter` takes its own store so Redis or a Postgres table can be
  substituted without touching a call site.

## Authorization model

**Organizations** are the tenant. A user belongs to one or more via a
`Membership` carrying exactly one **role scoped to that org**.

| Role | Can |
| --- | --- |
| `owner` | everything, including billing and deleting the org |
| `admin` | full schedule and roster control |
| `scheduler` | generate and edit schedules; **cannot** change members or roles |
| `coach` | read published schedules, request reschedules and edit their own team's roster |
| `referee` | see only their own assignments, set availability, accept/decline, and ask for games short an official |
| `viewer` | read published schedules |

Roles map to named permissions in [`src/lib/authz.ts`](src/lib/authz.ts) — the
single source of truth. `PERMISSIONS[role]` is what the server checks and what the
dashboard displays, so the two can never drift.

### How enforcement works

Every org-scoped API handler starts with:

```ts
const { actor, role } = await requirePermission(req, orgId, 'member:update_role')
```

which (1) resolves the session cookie against the database, (2) reads the actor's
membership **for that org** fresh on every request, and (3) checks the permission.
Nothing consults a client-supplied role, and a role revoked a moment ago is
enforced on the next call. Pages use `requireOrgAccess()`, which applies the same
rules; hidden nav links are a convenience, never the control.

Four deliberate details:

- **Non-members get 404, not 403.** Whether an organization exists is itself private.
- **Escalation is blocked separately from permission.** Holding `member:update_role`
  is not enough: `canAssignRole()` also refuses to grant a role above the actor's own
  rank and reserves granting or revoking `owner` for owners.
- **An org can never be left without an owner.** The last owner cannot be demoted or removed.
- **Every entity id is proved to belong to the org in the URL.** A permission check
  alone is not enough — a real member of org A could otherwise pass their own `orgId`
  with a team id from org B. The `assert*InOrg` helpers in
  [`src/lib/scope.ts`](src/lib/scope.ts) resolve the whole chain (team → division →
  season → league → org) and 404 if it does not terminate at that org.

### Team-scoped and self-scoped permissions

Some permissions end in `:own` and need a second, row-level check:

| Permission | Held by | Scope check |
| --- | --- | --- |
| `roster:write:own` | coach | `requireTeamRosterWrite` — team must be one they are staff of |
| `official:availability:write:own` | referee | `requireAvailabilityWrite` — their own referee record |
| `official:respond:own` | referee | `requireAssignmentRespond` — their own assignment |
| `official:request:own` | referee | `requireOwnRefereeRequest` — the referee is taken from the session, and the create schema has no `refereeId` field at all |

"Their own" resolves through `Person.userId`: a login is tied to one Person record,
and that Person's staff `TeamMembership` rows are their teams. A user with no linked
Person, or one attached only as a *player*, fails every `:own` check — the scope
resolution fails closed rather than open.

The team id always comes from the URL, and nested rows are loaded with both their own
id and the parent id from the URL. That closes the smuggling case: passing another
team's membership id through a URL naming your own team returns 404 rather than
editing it.

### Session and credential handling

- Passwords hashed with argon2id; session and reset tokens are 256-bit random
  values stored only as SHA-256 digests.
- Login returns the same error and does comparable work for an unknown email and a
  wrong password, so it cannot be used to enumerate accounts. The
  forgot-password endpoint responds identically either way.
- A password change or reset bumps `User.sessionsValidFrom` **and** revokes
  outstanding sessions, so every other device is signed out.
- Users can list their active sessions and revoke one or all others.
- Reset links are single-use, expire in an hour, and requesting a new one
  invalidates the old.

### Deletion and history

Entities carry `deletedAt` and are soft-deleted. `AuditEvent` rows are
append-only — actor, timestamp, entity type and id, action, and a field-level
before/after JSON diff — and are written **inside the same transaction** as the
mutation, so a rolled-back write cannot leave a phantom entry and a committed one
can never be missing its entry. A rejected write records nothing; a no-op `PATCH`
records nothing either, since the log tracks changes rather than requests. Phase 4
builds schedule versions, diffs and restore on top of this table.

Uniqueness on soft-deletable names (a team name within a division, a division name
within a season) is enforced in the application layer scoped to `deletedAt: null`,
not by a database index. An index would keep a soft-deleted row's name reserved
forever; `assertNameAvailable` in [`src/lib/crud.ts`](src/lib/crud.ts) does not.

### Hard constraints

[`src/lib/conflicts.ts`](src/lib/conflicts.ts) is the single definition of "this
placement is illegal", shared by manual game editing now and the phase 3 generator
and phase 5 calendar later:

| Constraint | Rule |
| --- | --- |
| `field_double_booked` | overlapping game on the same field, plus any configured buffer |
| `team_double_booked` | a team cannot be in two places at once |
| `outside_field_availability` | must sit inside a published slot, judged in venue-local time |
| `blackout_date` | org, division, team or venue blackout covering the venue-local date |
| `referee_unavailable` | blackout, outside a weekly window, overlapping assignment, or too little travel time |
| `referee_daily_cap` | more games that venue-local day than their cap |
| `referee_conflict_of_interest` | on one of the teams, or related to someone who is |

A violating write is refused with `409` and the full conflict list. Supplying
`overrideReason` proceeds anyway and records the reason **and the conflicts it
overrode** on the audit event — the "warn, but let an admin override with a logged
reason" rule. Cancelled and postponed games release their slot; a score-only edit
skips the placement re-check.

## Scheduling engine

[`src/lib/scheduler/`](src/lib/scheduler) is a **pure function**: config and entities
in, games out. No database, no clock, no `Math.random()`. That is what makes it
testable from fixtures and what makes non-negotiable #5 — same config, same seed, same
schedule — an assertion rather than a hope. `src/lib/scheduler/db.ts` is the only file
in the directory that knows Prisma exists.

```ts
const result = generateSchedule({ config, season, divisions, fields, referees, blackouts })
//    result.games, result.assignments, result.byes, result.report
```

A run goes: resolve config and seed the RNG → expand field availability rules into
concrete UTC slots → build the fixture list from the round robin → drop fixtures a
regeneration must leave alone → place fixtures into slots → assign officials →
optionally reserve playoff slots → report what was relaxed.

### Hard versus soft

**Hard constraints are absolute.** Field double-booking, a team in two places at once,
field availability windows, blackouts at all four scopes, the per-team game caps, and
every officiating rule. A slot that violates one is never offered to the placement
search, so an illegal schedule cannot be emitted. When a fixture has no legal slot
left it is **reported as unplaced**, never forced.

**Soft constraints are scored.** Each candidate slot gets a cost — home/away balance,
repeat opponents, time-of-day rotation, venue spread, rest days, home-venue preference,
sibling proximity, and staying near the intended round — and the cheapest legal slot
wins. Whatever cost survives is what the report describes.

### The report

`result.report.softConstraints` answers the spec's question directly: for each
constraint, whether it was relaxed, by how much in its own units, and which teams were
affected. Alongside it: per-team games / home / away / byes / shortest rest / time-slot
spread, unplaced fixtures with the binding constraint named, unfilled officiating
positions with the reason, officiating load and pay per official, and plain-language
notes about anything the generator had to derive.

### Officials

An official is assigned only if they clear all four rules: availability (no blackout,
inside a declared weekly window), their daily cap counted in the venue's local day, no
overlapping assignment and enough travel time between venues, and no conflict of
interest — on either team, or related to someone who is. Among those who qualify the
choice balances load then pay, so both the work and the money spread across the pool.

### Placement search

Greedy, with backtracking, as the spec suggests — no constraint solver. Fixtures are
placed in round order into their cheapest legal slot; when one has nowhere to go the
search unwinds and tries the next-best slot for an earlier fixture. `maxBacktrackSteps`
bounds the work so generation always terminates, and the report says when the budget
was reached. A fixture proven unplaceable is set aside and the pass restarts without
it, which keeps the search obviously correct rather than splicing a half-unwound stack.

### Generating from the app

`POST /api/orgs/:orgId/seasons/:seasonId/generate` requires `schedule:generate`.
It defaults to a **dry run**: the engine executes, the report and full game list come
back, and nothing is written. Passing `commit: true` writes the schedule in one
transaction — preserved games are left exactly where they are, the rest are
soft-deleted into history, and a single `schedule.generated` audit event records the
config, the seed, the counts and which soft constraints were relaxed.

### A note on capacity

The engine will tell you when a season is over-subscribed rather than quietly dropping
fixtures. A 9-team double round robin is 72 games, 16 per team; twelve Saturdays at the
default one game per team per day allows 12 per team, so 48 fit and 24 do not. Raising
`maxGamesPerTeamPerDay` to 2 for Saturday double-headers fits all 72. Both cases are
covered in the tests.

## Revision history

Versioning is a first-class feature, not a log tacked on the side.

### Schedule versions

A `ScheduleVersion` is an **immutable snapshot** of a season's games, written on every
generation and every manual save. It carries a per-season number, a label, an author,
a timestamp, an optional note, and where it came from (`generated` / `manual_save` /
`restore`).

Snapshots denormalize every name they display — teams, venues, fields, officials —
so a version renders the same way in a year's time even if a team is renamed or a venue
is retired. Storing only ids would let old versions silently change meaning, which
defeats the point.

Nothing ever updates a snapshot. A restore writes a **new** version rather than
deleting the ones after it, so history only ever grows: restoring v1 when v2 exists
produces v3, and v1 and v2 both remain exactly as they were.

### Diffing

`diffSnapshots` is a pure function in
[`src/lib/versions/snapshot.ts`](src/lib/versions/snapshot.ts). It reports games
**added**, **removed**, **moved** (with the old and new time and field, and how many
minutes it shifted), and **officials changed** (added, removed, and acceptance status).

Matching runs in three passes, most reliable first: same row id, then same fixture
(division + teams + round), then same pairing regardless of round. The fixture pass is
what makes a regeneration readable — every `Game` row is replaced, so without it a
regeneration would read as "72 removed, 72 added" instead of "these eight moved".
Either side of a diff can be the literal `live`, which is how an admin sees what
hand-editing has changed since the last save.

### Publishing

Publishing is explicit, and it is the only thing that changes what coaches, referees
and viewers see. Exactly one version per season is published at a time; publishing a
newer one archives the previous rather than deleting it.

The read split is enforced in one place, `readableSnapshot`:

| Holds | Sees |
| --- | --- |
| `schedule:read` (owner, admin, scheduler) | the live working draft |
| only `schedule:read:published` (coach, referee, viewer) | the published version's snapshot |

A published read is served **from the frozen snapshot, not from live rows**, so an
edit made a second ago cannot leak through. Before anything is published, those roles
see no schedule at all.

### The audit trail

Every mutation appends an `AuditEvent`: actor, timestamp, entity type and id, action,
and a field-level before/after JSON diff. Generating a season writes one event per
game and per assignment as well as the season-level event, so the per-game history
panel is populated for generated games too — batched into a single insert to keep that
affordable.

Two UI surfaces read it: a **per-entity history panel** on the game detail page ("who
changed this game and when", including any override reason recorded at the time), and a
**global activity feed** filterable by actor, entity type and date range, with facet
counts so the filters show what actually exists.

### The public page

`/s/<org-slug>` is the schedule with no session at all. It reads through the same
`readSchedule` with `canReadDrafts` hard-coded false, so it cannot see a live row even in
principle — publishing is the only thing that puts anything there, and a season with
nothing published `404`s rather than rendering an empty page. Officials are hidden: the
public needs to know when and where a game is, not who is refereeing it.

## Timezones

Two kinds of value exist and [`src/lib/time.ts`](src/lib/time.ts) keeps them apart:

**Instants** — a game kickoff. `timestamptz` holding UTC, rendered in the venue's
zone. Every venue carries a required IANA zone; games are grouped and displayed by
the *venue-local* date, so an 8pm Pacific Saturday game is not filed under Sunday
because UTC says so.

**Local wall-clock rules** — "Field 2, Saturdays 8am–6pm, Mar 1 – Jun 15", and
referee weekly availability. Stored as day-of-week plus minutes-from-midnight plus a
calendar date range, *not* as instants. That is the only way "8am" keeps meaning 8am
across a daylight-saving change: the same rule resolves to 16:00Z in March and 15:00Z
in April, and both read as 8am at the venue.

`zonedTimeToUtc` finds a self-consistent offset rather than guessing once. The two
awkward cases resolve deterministically, matching the convention Temporal calls
*compatible*: an ambiguous reading (the hour repeated when clocks go back) takes the
first occurrence; a nonexistent one (the hour skipped going forward) shifts forward
past the gap. Calendar dates — season bounds, dates of birth, blackout ranges — are
`date` columns parsed to UTC midnight, so they never shift zone at all.

Getting this right up front was deliberate; it is painful to retrofit.

## Testing

```bash
npm test
```

353 tests across thirteen files. The engine, diff, CSV and iCal tests run purely off
fixtures; the rest run against real Postgres so every authorization path is exercised as
deployed. Route
handlers read cookies from the `Request` and write them onto the `Response` rather
than going through `next/headers`, which keeps each one a pure `Request -> Response`
function that tests can call directly without booting Next.

- **`tests/authz.test.ts`** — the permission matrix and role-assignment rules.
- **`tests/auth-flows.test.ts`** — signup, login, logout, reset, change-password,
  session lifecycle, and negative cases (expired session, soft-deleted user,
  replayed reset link, revoking someone else's session).
- **`tests/org-authorization.test.ts`** — tenant isolation, the invitation round
  trip, and per-role endpoint enforcement, including that a **scheduler cannot
  change roles, invite, remove members, or touch the org** and that an admin
  cannot demote an owner or delete the org.
- **`tests/team-scope.test.ts`** — non-negotiable #1: a **coach token cannot mutate
  another team's data**. Adding, editing and removing on a rival roster all 403;
  reaching a rival roster row through the coach's *own* team URL 404s; refused
  attempts write no audit event; and the scope fails closed for a coach with no
  linked Person, one attached only as a player, or one since removed from the team.
- **`tests/time.test.ts`** — DST correctness: 8am local either side of both
  transitions, ambiguous and nonexistent readings, half-hour offsets, southern-
  hemisphere zones, and local-vs-UTC day boundaries.
- **`tests/entities.test.ts`** — the structure chain, cross-org parents rejected at
  every level, soft-delete then name reuse, local-minute time slots, and per-role
  enforcement on the phase 2 endpoints.
- **`tests/conflicts.test.ts`** — every hard constraint, the override-with-reason
  flow and its audit record, and the officiating rules from acceptance scenario 3.
- **`tests/scheduler.test.ts`** — the engine, from fixtures with no database. Includes
  the four cases non-negotiable #4 asks for (odd team count, single venue with tight
  slots, a referee with heavy blackouts, mid-season regeneration preserving played
  games) and the idempotence guarantee of non-negotiable #5.
- **`tests/generate-endpoint.test.ts`** — the database adapter and commit path: a dry
  run writes nothing, committing retires the previous schedule into history rather
  than deleting it, played games survive a regeneration untouched, and real blackouts
  and conflict-of-interest links reach the engine.
- **`tests/versions.test.ts`** — revision history, including both remaining acceptance
  scenarios: regenerate, diff v1 against v2, restore v1 and confirm v3 holds v1's
  content with the audit trail intact (5); and publish, then confirm a coach sees only
  the published version while the draft moves on beneath them (6). Plus the pure diff,
  snapshot immutability, and the filterable activity feed.
- **`tests/schedule-ui.test.ts`** — acceptance scenario 4 end to end: drag a game onto an
  occupied slot, get a 409 naming `field_double_booked`, confirm nothing moved, override
  with a reason, and find the reason and the overridden conflicts on the audit event.
  Plus local-time editing across zones, the officials candidate endpoint and its
  conflict-of-interest refusal, CSV parsing against awkward input, the import's
  all-or-nothing commit, and the read layer's published/draft split.
- **`tests/distribution.test.ts`** — the export surfaces, which are where authorization
  is easiest to lose: an export honours the published/draft split, a calendar token dies
  when its owner's membership does, a coach cannot subscribe to a team they do not coach,
  a wrong token and a revoked one return byte-identical 404s. Plus iCal correctness
  (stable UIDs, octet-safe line folding, `STATUS:CANCELLED` rather than a silent
  removal) and notification dispatch, preference gating and suppression records.
- **`tests/officiating.test.ts`** — referee self-service, which is mostly a set of
  refusals: a referee cannot volunteer *another* referee (the body's `refereeId` is
  ignored because the schema has no such field), cannot request a game they have a
  conflict of interest in — with no override available to them at all — cannot approve
  their own request, and cannot withdraw somebody else's. A coach and a viewer cannot
  request; a referee-role member with no `Referee` record is told why. Plus: approval
  creates an accepted assignment and audits both rows, the hard rules are re-checked at
  approval rather than trusted from request time, an assigner's override reason lands
  against the specific conflict, the five board buckets sort correctly, a declined
  assignment can be taken back, and the batch evaluator's verdict matches
  `detectOfficialConflicts` game-by-game.

## Project layout

```
prisma/
  schema.prisma          models; timestamptz + soft deletes throughout
  migrations/
  seed.ts                idempotent demo data
src/
  app/
    api/                 route handlers — all mutations, all permission-checked
    (auth)/              login, signup, forgot/reset password, accept invite
    (app)/               authenticated shell: dashboard, setup, schedule (list,
                         calendar, per-team/venue/official, print), officiating
                         board, leagues, venues, people, members, subscriptions
    s/[orgSlug]/         the public schedule — no session, published version only
  lib/
    authz.ts             role -> permission matrix, escalation rules
    scope.ts             assert*InOrg tenant scoping; own-team / own-assignment scope
    conflicts.ts         hard-constraint checking for one game placement
    csv.ts               dependency-free CSV parser and roster row validation
    notify.ts            recipient resolution, preference gating, mail dispatch
    schedule/            the display layer
      read.ts              the one published-vs-draft read, normalised to rows
      grid.ts              the date x field x time grid the editor drops onto
    export/              getting the schedule out
      csv.ts               schedule, roster and assignment renderings
      ical.ts              RFC 5545 generation; stable UIDs, octet-safe folding
      feeds.ts             subscription tokens, re-authorized on every fetch
    versions/            revision history
      snapshot.ts          snapshot shape and the pure diff
      service.ts           create, publish, restore, and the read split
    scheduler/           the engine — pure; db.ts is its only Prisma boundary
      types.ts             config and entity inputs, result and report shapes
      config.ts            defaults, normalization, wire-format schema
      random.ts            seeded PRNG, so generation is reproducible
      slots.ts             availability rules -> concrete UTC candidate slots
      pairings.ts          round robin, byes, home/away orientation, cross-division
      placement.ts         greedy placement with backtracking; hard vs soft
      officials.ts         referee assignment and load/pay balancing
      playoffs.ts          standings and elimination brackets
      report.ts            what was relaxed, by how much, for which teams
      db.ts                loads a season out of Postgres into the pure input
    time.ts              UTC instants vs local wall-clock rules, zone conversion
    http.ts              requirePermission / requireActor, error mapping
    crud.ts              write + audit in one transaction; soft delete; name uniqueness
    roster.ts            roster invariants shared across endpoints
    session.ts           session lifecycle and cookie plumbing
    auth-server.ts       server-component equivalents
    audit.ts             append-only audit events and field diffs
    password.ts          argon2id hashing
    mailer.ts            console (dev) and SMTP transports
    validation.ts        Zod schemas
  components/
tests/
```

## Data model

`League → Season → Division → Team`, with `Person` reused across every role a human
holds (`TeamMembership` carries the role, jersey number and active date range).
`Referee` flags a Person as an official and carries certification, pay rate in integer
cents, a daily cap and a travel buffer; `RefereeAvailability` holds weekly windows and
blackouts. `Venue → Field → TimeSlot` covers places and when they are usable. `Game`
links a season, division, two teams and a field to a UTC instant, with `GameOfficial`
for assignments and acceptance. `BlackoutDate` applies at org, division, team or venue
scope. `PersonRelationship` records family links, which drive both the officiating
conflict-of-interest rule and the phase 3 "keep siblings' games close together"
weighting.

`CalendarFeed` holds an iCal subscription: a SHA-256 token digest bound to the user who
created it plus a scope, revoked rather than deleted so the audit trail can still say which
feed was turned off and when. `NotificationPreference` is per user per org, and an absent
row means the column defaults.

Everything soft-deletes. Money is integer cents — no floats, no `Decimal`
serialization traps.

## What each role sees

The dashboard is chosen by role, from the same permission matrix the server enforces
([`src/app/(app)/app/[orgSlug]/page.tsx`](src/app/\(app\)/app/[orgSlug]/page.tsx)
dispatches; the loaders are in [`src/lib/dashboard.ts`](src/lib/dashboard.ts)). Each
one leads with the thing that role opens the app to find out, rather than one page
accumulating a conditional per panel:

| Role | Leads with |
| --- | --- |
| coach | their next fixture, their teams' upcoming games, roster size and record |
| referee | what is waiting on their answer, then confirmed games, then what is going spare |
| viewer | what is on next, recent results, divisions, and how to subscribe |
| organizer | what is unfinished across the org — unstaffed games, an unpublished draft, requests waiting |

Navigation is shaped the same way: a coach gets a direct link to their own team, a
referee gets **My games** with a badge counting assignments still needing an answer.
Both are resolved from the session, never from the URL. Hiding a link is a
convenience, not a control — every endpoint re-checks, which is what
`tests/officiating.test.ts` and `tests/team-scope.test.ts` assert directly against the
API.

Role is a *presentation* choice. It changes which panels render, never what the server
will accept.

## Officiating: assignments and requests

A referee's page ([`/app/[orgSlug]/officiating`](src/app/\(app\)/app/[orgSlug]/officiating/page.tsx))
splits their work into the states they actually distinguish:

| Section | Means |
| --- | --- |
| Waiting on your answer | offered to them; an assigner is blocked until they respond |
| Confirmed | accepted — they are officiating |
| You asked for these | their own requests, pending an assigner |
| You declined | kept visible, because a mistaken decline is recoverable |
| Games needing an official | short a crew member, with a per-game verdict on whether *they* may take it |

Their availability editor lives on that page too. It had to: a referee does not hold
`roster:read`, so `/people/[personId]` — the only place availability could be edited —
was unreachable to them. They held `official:availability:write:own` with no page to
exercise it on.

### Asking to officiate

`OfficiatingRequest` is its own model, deliberately **not** a `GameOfficial` with an
extra status. A `GameOfficial` row means "on the crew" everywhere in this codebase,
and conflict detection counts any non-declined assignment as consuming that referee's
time and daily cap. Folding requests into it would mean merely *asking* for a game
blocked you from being assigned elsewhere — and would let a referee manufacture a
conflict for themselves.

Four rules the request endpoint enforces:

1. **The referee comes from the session.** `createOfficiatingRequestSchema` has no
   `refereeId` field, so there is nothing to spoof. A referee volunteers for
   themselves or not at all.
2. **Hard constraints are refused outright, with no override.** An assigner may
   override a conflict of interest with a logged reason; a referee may not do it for
   themselves, or the rule is decorative.
3. **They are re-checked at approval time**, not trusted from when the request was
   made — the crew, the referee's other games and the kickoff can all have moved.
4. **Approval creates the assignment in the same transaction** as the status change,
   already `accepted`. A request marked approved with no assignment behind it is a lie
   the referee acts on, and asking someone to confirm a game they proposed is a
   pointless round trip.

Open positions are computed from **live** `GameOfficial` rows even for a reader who is
otherwise served the published snapshot. Publishing freezes the crew alongside the
fixtures, but a decline happens operationally and does not wait for a new version — so
reading the frozen crew would hide exactly the openings this feature exists for, and
would disagree with the endpoint that decides whether a request is accepted.

That last point is the general pattern here: the batch evaluator that labels a whole
season of candidate games and the single-game gate at write time both call one pure
function, `officialConflicts` in [`src/lib/conflicts.ts`](src/lib/conflicts.ts).
`detectOfficialConflicts` is a thin wrapper over it. A referee is never shown a button
the server would refuse, and a test asserts the two agree game-by-game.

## Editing the schedule

Five views over one read layer — list, calendar (date × field), by team, by venue, by
official — all filtered from the same query parameters, all rendered in each venue's own
zone. `src/lib/schedule/read.ts` is the only place a schedule is read for display, which
is what keeps the published/draft split from having to be re-derived per page.

**Drag-and-drop** (acceptance scenario 4) is deliberately server-decided. A drop `PATCH`es
the game with no override reason. If the placement breaks a hard constraint the endpoint
refuses with `409` and the conflict list, which the UI renders with each constraint named;
only then does a reason box appear, and confirming re-sends the move with the reason
attached, where it lands on the audit event alongside the conflicts it overrode. The client
never decides whether a placement is legal — it cannot, since the rules involve rows it has
not loaded, and trusting it would put the constraint check on the wrong side of the wire.

The grid the editor drops onto is built on the server (`src/lib/schedule/grid.ts`) because
a cell's instant is zone arithmetic: the same 9:00 row means different instants on a Denver
field and a Los Angeles one, and different instants either side of a DST boundary. Moving a
game between venues keeps the local time the operator chose and changes the instant, which
is what picking "9:00" on a form means.

Kickoffs are edited as a date and a wall-clock time, never as an ISO string. The endpoint
accepts `localDate`/`localTime` and converts them in the *target* field's zone.

## Import and export

**Roster CSV import** previews by default. Every row is validated and every problem
reported — the parser does not stop at the first — so a file can be corrected in one pass
rather than one upload per mistake. A commit runs the same validation and refuses outright
if anything is wrong: a half-imported roster is worse than a rejected one, because nobody
can tell which half landed. Rows are matched to existing people by email, then by name, so
a re-import updates instead of duplicating. The parser handles what spreadsheets actually
emit — quoted fields, embedded commas and newlines, doubled quotes, CRLF, a UTF-8 BOM.

**CSV export** covers schedules, rosters and officiating assignments. Every schedule row
carries both the local reading and the UTC instant: the local date and time are what a
human pastes into a newsletter, the ISO instant is what another system can import without
guessing a zone. Roster exports emit exactly the columns the importer reads, so a file
round-trips. Exports read through the same `readSchedule`, so a coach exporting gets the
published snapshot — an export is otherwise the easiest way to leak an unpublished draft.

**Printing** goes through the browser's own print-to-PDF rather than a bundled PDF
renderer. That costs one stylesheet instead of a rendering dependency, inherits the
platform's font handling, and produces a real vector PDF with selectable text. What it
gives up is server-side generation. The print rules that carry the weight are the
page-break ones: a day's heading must not be orphaned from its table, and a game row must
not be split across two sheets.

**Live iCal feeds** are per-team, per-official or org-wide. A calendar client fetches on a
timer with no cookie, so the credential is the URL: 256 bits of entropy, stored as a
SHA-256 digest, shown once at creation, revocable. Two things make that safe —

- Authorization is re-derived on every fetch from the owner's **live** membership, never
  frozen into the feed. Removing someone from the org, or dropping them from coach to
  viewer, changes what their existing URL returns on the next poll, without anyone having
  to remember the feed exists.
- A feed never serves a draft. Everyone who subscribes to a calendar is by definition
  outside the office, so they get the published snapshot — same as the public page.

Every failure returns the same bare `404`. A calendar client cannot act on a distinction,
and telling a prober that a token was once valid is a disclosure for nothing.

UIDs are derived from the game id, so a rescheduled game **moves** in a subscriber's
calendar rather than appearing twice; a random UID per render would duplicate the whole
season on every poll. Times are emitted as UTC instants and rendered by the client in the
subscriber's own zone. A cancelled game is emitted as `STATUS:CANCELLED` rather than
dropped, because silently removing it leaves a stale entry in the subscriber's calendar
forever.

## Notifications

Emails on publish, reschedule and assignment change, each with a per-user, per-org
preference. Three rules:

1. **Never inside the mutation's transaction.** A mail send that fails or hangs must not
   roll back a published schedule, and a transaction must not be held open across a network
   call to an SMTP server. Callers dispatch after their write commits.
2. **Recipients come from the data, then get filtered by preference.** A missing preference
   row means the defaults, so nobody needs back-filling when a new kind is added — a
   missing row and an untouched row behave identically.
3. **One audit row per notification**, including the ones a preference suppressed. "Why
   wasn't I told?" has to be answerable, and a suppressed delivery recorded as nothing at
   all is indistinguishable from a bug.

A failure is swallowed per-recipient and reported in the response. One bounced mailbox does
not undo a publish. Players are deliberately not notified: a youth roster is mostly minors
without logins, and a `Person` is only reachable at all once linked to a user account.

Two things are deliberately quiet. A move emails only on a real move — `placementChanged`
is true for a status change too, so the dispatch is gated on the start time or the field
actually differing, because a score entry is not something to wake a coach's phone for.
And a roster change never emails whoever made it: telling someone about their own edit is
noise, and it is the fastest way for a notification system to lose people's trust.
