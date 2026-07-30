# Sports Scheduler

League scheduling for any sport: define teams, people, venues, officials and rules,
generate a season schedule that respects every hard constraint, then review,
publish and roll back with a full audit trail.

**Status: Phase 1 (auth and accounts) complete.** Phases 2–6 — core data model,
scheduling engine, revision history, UI, and import/export/notifications — are next.

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

`npm run seed` creates **Riverside Youth Soccer** with one user per role.
Password for all of them is `demo-password-123`:

| Role | Email |
| --- | --- |
| owner | `owner@riverside.example` |
| admin | `admin@riverside.example` |
| scheduler | `scheduler@riverside.example` |
| coach | `coach@riverside.example` |
| referee | `referee@riverside.example` |
| viewer | `viewer@riverside.example` |

The seed script is idempotent and prints a live invitation-accept link on each run.

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

Three deliberate details:

- **Non-members get 404, not 403.** Whether an organization exists is itself private.
- **Escalation is blocked separately from permission.** Holding `member:update_role`
  is not enough: `canAssignRole()` also refuses to grant a role above the actor's own
  rank and reserves granting or revoking `owner` for owners.
- **An org can never be left without an owner.** The last owner cannot be demoted or removed.

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
can never be missing its entry. Phase 4 builds schedule versions, diffs and
restore on top of this table.

## Timezones

`DateTime` columns are `timestamptz` and always hold UTC. Organizations and
(from phase 2) venues carry an IANA zone used purely for rendering. Getting this
right up front is deliberate — it is painful to retrofit.

## Testing

```bash
npm test
```

51 tests across three files, running against real Postgres so every
authorization path is exercised as deployed. Route handlers read cookies from the
`Request` and write them onto the `Response` rather than going through
`next/headers`, which keeps each one a pure `Request -> Response` function that
tests can call directly without booting Next.

- **`tests/authz.test.ts`** — the permission matrix and role-assignment rules.
- **`tests/auth-flows.test.ts`** — signup, login, logout, reset, change-password,
  session lifecycle, and negative cases (expired session, soft-deleted user,
  replayed reset link, revoking someone else's session).
- **`tests/org-authorization.test.ts`** — tenant isolation, the invitation round
  trip, and per-role endpoint enforcement, including that a **scheduler cannot
  change roles, invite, remove members, or touch the org** and that an admin
  cannot demote an owner or delete the org.

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
    (app)/               authenticated shell: dashboard, members, account
  lib/
    authz.ts             role -> permission matrix, escalation rules
    http.ts              requirePermission / requireActor, error mapping
    session.ts           session lifecycle and cookie plumbing
    auth-server.ts       server-component equivalents
    audit.ts             append-only audit events and field diffs
    password.ts          argon2id hashing
    mailer.ts            console (dev) and SMTP transports
    validation.ts        Zod schemas
  components/
tests/
```

## Roadmap

- **Phase 2** — leagues, seasons, divisions, teams, people, referees and
  availability, venues, fields, time slots, games, officials, blackout dates.
- **Phase 3** — the scheduling engine: a pure function (config + entities in,
  games out) with hard constraints never violated and soft constraints scored and
  reported.
- **Phase 4** — schedule versions, side-by-side diffs, restore-as-new-version,
  per-entity history, activity feed, explicit publishing.
- **Phase 5** — dashboard, setup wizard, calendar/list/per-team views,
  drag-and-drop editing with override-and-log, referee assignment board, CSV
  roster import, public schedule page.
- **Phase 6** — CSV import/export, PDF and live iCal feeds, transactional email,
  per-user notification preferences.
