# Deploying to sports.zicaworld.com

This app is a Node server plus a PostgreSQL database. That single sentence decides
everything below, so read the constraint before picking a path.

## The constraint, stated plainly

**GreenGeeks shared hosting cannot run this application as built.** Shared cPanel
plans provide MySQL/MariaDB. This schema is not casually Postgres-flavoured — it is
Postgres-dependent:

| Feature | Count | MySQL equivalent |
|---|---|---|
| `@db.Timestamptz` columns | 81 | none — MySQL `TIMESTAMP` has no zone awareness |
| `jsonb` columns | 5 | `JSON`, but with different functions and no `jsonb_array_length` |
| Native enum types | 13 | different semantics |
| **Partial unique indexes** | **4** | **none — MySQL has no partial indexes at all** |

That last row is the hard stop. Those four indexes are what stop two officials being
seated in the same position by two concurrent requests, and they are enforced with a
`WHERE "deletedAt" IS NULL AND status <> 'declined'` predicate. MySQL cannot express
that. Porting to MySQL means deleting those protections and going back to a
check-then-insert race — which is the defect they were added to fix.

So: PostgreSQL is not a preference here. Choose a path that has it.

## Path A — run the app anywhere that does Postgres, point the domain at it

**Recommended.** The subdomain is DNS; it does not require the app to live on
GreenGeeks. If zicaworld.com's DNS is managed at GreenGeeks, you keep using
GreenGeeks for the domain and the app runs somewhere it works.

1. Deploy the app to a Node + Postgres host (Vercel + Neon, Railway, Render, Fly).
   `DEPLOYMENT.md` in the repository root covers the Vercel route, including a
   phone-only path that never asks you to type a connection string.
2. In GreenGeeks cPanel → **Zone Editor** for `zicaworld.com`, add:

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | CNAME | `sports` | the host's target, e.g. `cname.vercel-dns.com` | 300 |

   Use the exact target the host gives you — it differs per provider, and a guessed
   CNAME fails silently until the certificate cannot be issued.
3. Add `sports.zicaworld.com` as a custom domain in the host's dashboard so it can
   issue the TLS certificate.
4. Set `APP_URL=https://sports.zicaworld.com` in the host's environment. Invitation
   and password-reset links are built from it; left unset they point somewhere else
   and the flows appear broken.

Nothing in `deploy/` is needed for this path.

## Path B — a GreenGeeks VPS

A VPS gives root, so Postgres and Node are both installable and this becomes an
ordinary Linux deployment. Everything needed is in this directory:

| File | Purpose |
|---|---|
| `provision.sh` | One-time: Node 22, PostgreSQL 16, nginx, certbot, a service user, firewall |
| `deploy.sh` | Every release: fetch, `npm ci`, migrate, build, restart |
| `nginx/sports.zicaworld.com.conf` | TLS termination and reverse proxy |
| `systemd/sports-scheduler.service` | Keeps the app running and restarts it on failure |

```bash
# On the VPS, as root:
git clone https://github.com/peterpblends/Sports-Scheduler.git /opt/sports-scheduler
cd /opt/sports-scheduler
bash deploy/provision.sh                    # prompts for nothing; prints what to do next
# then edit /etc/sports-scheduler.env  (DATABASE_URL, APP_URL, SMTP)
bash deploy/deploy.sh
```

Point DNS at the VPS first, because certbot validates over HTTP:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `sports` | your VPS IPv4 | 300 |
| AAAA | `sports` | your VPS IPv6, if it has one | 300 |

## Path C — port to MySQL for shared hosting

Possible, and I do not recommend it. It costs the four partial unique indexes (so the
officiating races come back), a rewrite of every `Timestamptz` column with an explicit
UTC convention enforced in application code instead of by the database, replacement of
`jsonb_array_length` in a migration, and a re-run of the whole test suite against a
different engine. It trades away correctness guarantees to fit hosting that costs a few
dollars less. If you want it anyway, say so and I will scope it honestly.

## What the app needs from whatever runs it

These matter regardless of path, and getting them wrong produces failures that look
like application bugs:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Required. Use the **direct**, non-pooled URL — migrations need a real session. |
| `APP_URL` | `https://sports.zicaworld.com` | Email links are built from this. |
| `TRUSTED_PROXY_HOPS` | `1` behind one nginx | The client address is read this many entries from the right of `X-Forwarded-For`. Wrong value means audit rows record the proxy, or a spoofable value. |
| `NODE_ENV` | `production` | Gates the `Secure` cookie flag and HSTS. |
| `MAIL_TRANSPORT` | `smtp` | The default `console` transport writes mail to disk instead of sending it, so nobody can complete an invitation or a reset. |
| `SMTP_URL`, `MAIL_FROM` | your mail credentials | GreenGeeks provides mailboxes; a cPanel account works here. |

The reverse proxy must forward `X-Forwarded-Proto` and `X-Forwarded-Host`. The CSRF
check compares the browser's `Origin` against the forwarded host, so without them every
write is rejected as cross-site. `nginx/sports.zicaworld.com.conf` sets both.
