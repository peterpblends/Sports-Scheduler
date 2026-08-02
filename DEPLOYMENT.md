# Deploying

The app is a standard Next.js server app plus a Postgres database. Nothing about it
is Vercel-specific — it will run anywhere that can run Node 22 and reach Postgres —
but the automated path below targets Vercel because it is the shortest route to a
working URL.

## What you have to do, and why it is you

Deployment needs two credentials: a Vercel token and a Postgres connection string.
They live in **GitHub Actions secrets**, never in this repository and never in a chat
transcript, which is the whole reason the deploy runs from a workflow rather than
from someone's terminal.

### 1. A Postgres database

Any hosted Postgres 16 works. [Neon](https://neon.tech) and
[Supabase](https://supabase.com) both have free tiers that are ample for a demo.
Create one and copy its connection string. It must include `sslmode=require` for most
hosted providers:

```
postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
```

Neon connection strings work as given. If you are using a connection pooler, use the
**direct** (non-pooled) URL — Prisma migrations need a real session.

### 2. A Vercel token

[vercel.com/account/tokens](https://vercel.com/account/tokens) → Create. Scope it to
the account or team you want the project under.

### 3. Add the secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | The Postgres connection string from step 1 |
| `VERCEL_TOKEN` | yes | The token from step 2 |
| `VERCEL_ORG_ID` | no | Set both of these to deploy into an **existing** Vercel project |
| `VERCEL_PROJECT_ID` | no | Find them in that project's Settings → General |

Leave the last two unset and the workflow creates a new Vercel project from this
repository on its first run.

### 4. Run it

**Actions → Deploy → Run workflow.** It also runs automatically on every push to
`main` or the working branch.

The workflow applies migrations, builds, deploys, and then polls the resulting URL
until it answers `200` — so a green run means the app is actually up, not merely that
the upload succeeded. The URL is printed in the run summary and on the deployment.

### 5. Optionally, load the demo data

**Actions → Seed demo data → Run workflow**, and type `seed` to confirm.

This is a separate, manual, confirmed workflow rather than a step in the deploy on
purpose: seeding writes data, and writing data should never be a side effect of
shipping code.

It creates 2 leagues, 17 teams, 229 people, 6 officials, and 2 venues over 3 fields,
with six logins — `owner@`, `admin@`, `scheduler@`, `coach@`, `referee@` and
`viewer@riverside.example`, password `demo-password-123`.

**Those are public credentials in a public repository.** Fine for a demo you are
showing someone; do not seed a deployment you intend to leave up and put real data
in.

## Environment variables

The deploy workflow sets `DATABASE_URL` and `MAIL_TRANSPORT` on the Vercel project.
Everything else has a working default. Set these yourself in the Vercel dashboard if
you want to change them:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required. |
| `APP_URL` | the deployment URL | Only used to build links in emails. Set it if you attach a custom domain, or invitation links will point at the `.vercel.app` host. |
| `SESSION_TTL_DAYS` | `30` | Session cookie lifetime. |
| `MAIL_TRANSPORT` | `console` | `console` writes messages to disk and logs them. Set `smtp` to actually send. |
| `MAIL_FROM` | `no-reply@example.com` | |
| `SMTP_URL` | — | Required when `MAIL_TRANSPORT=smtp`. |

### Email on a serverless host

The default `console` transport writes to the filesystem, which on Vercel is
ephemeral and per-invocation — messages effectively go nowhere. That is harmless for
a demo, and it is why nothing breaks without SMTP configured. For anything real, set
`MAIL_TRANSPORT=smtp` and an `SMTP_URL`; the invitation and password-reset flows are
unusable otherwise, because the links only ever arrive by email.

## Migrations

`npx prisma migrate deploy` runs as its own step **before** the deploy, not inside the
build. A Vercel build can run more than once for a single deployment, and schema
migration is not something to run concurrently with itself.

`migrate deploy` only applies migrations that already exist in `prisma/migrations/` —
it never generates one and never resets. Creating migrations stays a local, reviewed
act.

## Deploying somewhere else

There is nothing Vercel-specific in the application code. For any Node host:

```bash
npm ci
npx prisma migrate deploy   # needs DATABASE_URL
npm run build
npm start                   # serves on $PORT, default 3000
```

The one thing to get right is that `prisma generate` must run after dependencies are
installed. `postinstall` handles it, but hosts that restore a dependency cache can
skip `postinstall` — hence the `vercel-build` script, which runs it explicitly. If
your host caches `node_modules`, make its build command run `prisma generate` too.
