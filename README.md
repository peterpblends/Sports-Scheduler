# Sports Scheduler

League scheduling for any sport: define teams, people, venues, officials and rules,
generate a season schedule that respects every hard constraint, then review,
publish and roll back with a full audit trail.

**Status: Phases 1–4 complete** — auth and accounts, the core data model with its CRUD
surface and conflict checking, the scheduling engine, and revision history. Phases 5–6
— the full UI, and import/export/notifications — are next.

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

`npm run seed` creates **Riverside Youth Soccer**: 2 leagues, an active Spring 2026
season with a 9-team U12 Boys division (odd on purpose, so bye handling gets
exercised) and an 8-team U10 Girls division, 229 people on full rosters, 6 officials
with weekly availability and blackouts, 2 venues over 3 fields with Saturday
8am–6pm local slots across Mar 7 – May 30 2026, holiday and maintenance blackouts,
a sibling pair split across two teams, and one user per role.

That is deliberately the shape acceptance scenario 2 asks for, so the phase 3
generator can run against it with no extra setup.

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

## Authorization model

**Organizations** are the tenant. A user belongs to one or more via a
`Membership` carrying exactly one **role scoped to that org**.

| Role | Can |
| --- | --- |
| `owner` | everything, including billing and deleting the org |
| `admin` | full schedule and roster control |
| `scheduler` | generate and edit schedules; **cannot** change members or roles |
| `coach` | read published schedules, request reschedules and edit their own team's roster |
| `referee` | see only their own assignments, set availability, accept/decline |
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

257 tests across ten files. The engine and diff tests run purely off fixtures; the
rest run against real Postgres so every authorization path is exercised as deployed. Route
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
    (app)/               authenticated shell: dashboard, schedule, leagues,
                         venues, people, members, account
  lib/
    authz.ts             role -> permission matrix, escalation rules
    scope.ts             assert*InOrg tenant scoping; own-team / own-assignment scope
    conflicts.ts         hard-constraint checking for one game placement
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

Everything soft-deletes. Money is integer cents — no floats, no `Decimal`
serialization traps.

## Roadmap

- **Phase 5** — dashboard, setup wizard, calendar/list/per-team views,
  drag-and-drop editing with override-and-log, referee assignment board, CSV
  roster import, public schedule page.
- **Phase 6** — CSV import/export, PDF and live iCal feeds, transactional email,
  per-user notification preferences.
