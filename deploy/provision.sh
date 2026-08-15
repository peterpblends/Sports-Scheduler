#!/usr/bin/env bash
#
# One-time setup for a fresh Ubuntu 22.04/24.04 VPS to serve sports.zicaworld.com.
#
# Idempotent: safe to re-run. It installs nothing that is already present and does not
# overwrite the environment file if you have already filled it in.
#
# It deliberately does NOT put any secret in this repository. It writes a template to
# /etc/sports-scheduler.env with a generated database password and tells you what to
# fill in.
#
#   sudo bash deploy/provision.sh
#
set -euo pipefail

DOMAIN="${DOMAIN:-sports.zicaworld.com}"
APP_DIR="${APP_DIR:-/opt/sports-scheduler}"
APP_USER="sports"
DB_NAME="scheduler"
DB_USER="scheduler"
ENV_FILE="/etc/sports-scheduler.env"

say() { printf '\n=== %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx postgresql postgresql-contrib ufw

# Node 22 from NodeSource. Ubuntu's own package is too old for Next 15.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  say "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "node $(node -v), npm $(npm -v)"

say "Service user"
if ! id "$APP_USER" >/dev/null 2>&1; then
  # No login shell and no home directory: this account exists to run one process.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

say "PostgreSQL"
systemctl enable --now postgresql
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || {
  sudo -u postgres createdb "$DB_NAME"
  echo "created database $DB_NAME"
}

# Generate a password only if we are also creating the role, so a re-run does not
# invalidate the DATABASE_URL already in the environment file.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  DB_PASS="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
  sudo -u postgres psql -qc "ALTER DATABASE $DB_NAME OWNER TO $DB_USER"
  echo "created role $DB_USER"
else
  DB_PASS=""
  echo "role $DB_USER already exists; leaving its password alone"
fi

say "Application directory"
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Environment file"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
# Secrets for sports-scheduler. Root-owned, 0640, read by systemd only.
# Never commit this file.

DATABASE_URL="postgresql://$DB_USER:${DB_PASS:-CHANGE_ME}@127.0.0.1:5432/$DB_NAME?schema=public"

# Absolute origin. Invitation and password-reset links are built from it.
APP_URL="https://$DOMAIN"

# One nginx in front, so the client address is the entry one place from the right of
# X-Forwarded-For. Set to 0 if you ever remove the proxy.
TRUSTED_PROXY_HOPS=1

SESSION_TTL_DAYS=30

# The default "console" transport writes mail to disk instead of sending it, which
# makes invitations and password resets impossible to complete. Fill these in.
MAIL_TRANSPORT=smtp
MAIL_FROM="Sports Scheduler <no-reply@$DOMAIN>"
SMTP_URL="smtps://USER:PASSWORD@HOST:465"
ENV
  chmod 640 "$ENV_FILE"
  echo "wrote $ENV_FILE"
  [ -n "$DB_PASS" ] && echo "  (database password generated and filled in)"
else
  echo "$ENV_FILE already exists; leaving it untouched"
fi

say "systemd unit"
install -m 644 "$(dirname "$0")/systemd/sports-scheduler.service" \
  /etc/systemd/system/sports-scheduler.service
systemctl daemon-reload
systemctl enable sports-scheduler >/dev/null

say "nginx"
mkdir -p /var/www/certbot
install -m 644 "$(dirname "$0")/nginx/$DOMAIN.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default

say "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | head -6

say "TLS certificate"
# nginx cannot start with an ssl_certificate that does not exist yet, so the
# certificate is obtained before the config is validated. certbot's nginx plugin
# needs port 80 reachable, which means DNS must already point here.
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx
  if ! certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
        --non-interactive --agree-tos --register-unsafely-without-email 2>/dev/null; then
    cat <<'MSG'

Certificate not issued. This is almost always DNS: certbot has to reach
http://sports.zicaworld.com/.well-known/... from the public internet, so the A record
must already point at this server and have propagated.

Add in GreenGeeks cPanel -> Zone Editor for zicaworld.com:
    A    sports    <this server's IPv4>    TTL 300

Then re-run:  sudo bash deploy/provision.sh
MSG
    exit 1
  fi
else
  echo "certificate for $DOMAIN already present"
fi

nginx -t && systemctl reload nginx

cat <<MSG

=== Provisioning done.

Next:
  1. Fill in SMTP_URL in $ENV_FILE  (and DATABASE_URL if it says CHANGE_ME)
  2. bash deploy/deploy.sh
  3. Optionally seed demo data:  sudo -u $APP_USER npm --prefix $APP_DIR run seed

The app will be at https://$DOMAIN
MSG
