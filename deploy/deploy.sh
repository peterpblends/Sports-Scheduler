#!/usr/bin/env bash
#
# Release script. Run after every change you want live.
#
#   sudo bash deploy/deploy.sh          # deploys the current branch's latest commit
#   sudo REF=some-branch bash deploy/deploy.sh
#
# Order matters and is deliberate:
#
#   fetch -> install -> MIGRATE -> build -> restart
#
# Migrations run before the build and outside it. A build can be retried or run more
# than once; a schema migration must not be. `prisma migrate deploy` only applies
# migrations that already exist in the repository — it never generates one and never
# resets, so it cannot invent a destructive change on a production database.
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/sports-scheduler}"
APP_USER="sports"
REF="${REF:-}"
ENV_FILE="/etc/sports-scheduler.env"

say() { printf '\n=== %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE is missing. Run deploy/provision.sh first." >&2
  exit 1
fi
if grep -q 'CHANGE_ME' "$ENV_FILE"; then
  echo "$ENV_FILE still contains CHANGE_ME. Fill it in before deploying." >&2
  exit 1
fi

cd "$APP_DIR"

say "Fetching"
git fetch --prune origin
if [ -n "$REF" ]; then
  git checkout -q "$REF"
  git reset -q --hard "origin/$REF"
else
  branch="$(git rev-parse --abbrev-ref HEAD)"
  git reset -q --hard "origin/$branch"
fi
echo "at $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# The build and migrations need the environment; systemd normally supplies it.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export NODE_ENV=production

say "Dependencies"
# `npm ci` for a reproducible tree from the lockfile. Dev dependencies are needed
# because the Next build and Prisma CLI live there.
npm ci --include=dev

say "Migrations"
npx prisma migrate deploy

say "Build"
npm run build

say "Permissions"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Restart"
systemctl restart sports-scheduler

# Wait for it to actually answer rather than assuming a restart means a working app.
say "Health check"
ok=false
for _ in $(seq 1 30); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/login || echo 000)"
  case "$code" in
    2*|3*) echo "app answered $code"; ok=true; break ;;
  esac
  sleep 2
done

if [ "$ok" != true ]; then
  echo
  echo "The app did not come up. Last 40 log lines:" >&2
  journalctl -u sports-scheduler -n 40 --no-pager >&2
  exit 1
fi

# And through nginx, which is what the public actually hits. A 502 here with a healthy
# app behind it means the proxy config, not the application.
public="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: sports.zicaworld.com' \
  https://127.0.0.1/login --resolve 'sports.zicaworld.com:443:127.0.0.1' -k 2>/dev/null || echo 000)"
echo "through nginx: $public"

say "Deployed"
echo "https://sports.zicaworld.com"
