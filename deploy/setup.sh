#!/usr/bin/env sh
# Captivo Access — one-command production setup.
# Brings up the whole stack (Manager + data-plane + Postgres + Caddy) from the
# published images.
#
#   ./setup.sh access.example.com
#   # or: ACCESS_DOMAIN=access.example.com ./setup.sh
#
# Point DNS FIRST — three names at this host's public IP, ports 80 + 443 open:
#   manager.<domain>   connect.<domain>   *.<domain>   (wildcard, per-site access)
#
# Idempotent: re-running reuses the existing .env (secrets are generated ONCE)
# and just re-applies `docker compose up -d`. Delete .env to regenerate.

set -eu
cd "$(dirname "$0")"

COMPOSE="docker-compose.prod.yml"
ACCESS_DOMAIN="${1:-${ACCESS_DOMAIN:-}}"

CRON_MARKER="# captivo-access cron (managed by setup.sh — do not edit this block)"

# remove_legacy_cron strips the pre-v0.56 host-crontab block managed by older
# setup.sh versions. Scheduling now lives in the access-cron container, so
# leaving the old block would double-fire the endpoints. Safe no-op when absent.
remove_legacy_cron() {
  command -v crontab >/dev/null 2>&1 || return 0
  crontab -l 2>/dev/null | grep -qF "$CRON_MARKER" || return 0
  crontab -l 2>/dev/null \
    | grep -vF "$CRON_MARKER" \
    | grep -vE '/api/cron/(site-health|audit-retention|recording-retention|audit-anchor)' \
    | crontab -
  echo "→ Removed the legacy host-crontab jobs (scheduling now runs in the access-cron container)."
}

# The version this checkout ships, pinned into .env so a fresh install asks for
# an image that exists. The compose files carry the same value as a fallback, but
# a literal nobody bumps goes stale: it had drifted to 1.9.0 in one file and
# 1.10.0 in the other while the release was 1.14.0. That was invisible only
# because the old registry namespace still held every old tag -- after the move
# to a fresh namespace a default install asked for a version never published
# there, and failed.
VERSION="$(cat "$(dirname "$0")/../VERSION" 2>/dev/null || echo latest)"

if [ ! -f .env ]; then
  if [ -z "$ACCESS_DOMAIN" ]; then
    printf "Access domain (e.g. access.example.com): "
    read -r ACCESS_DOMAIN
  fi
  [ -n "$ACCESS_DOMAIN" ] || { echo "ACCESS_DOMAIN is required." >&2; exit 1; }

  echo "→ Generating .env for $ACCESS_DOMAIN (secrets created once)..."
  cat > .env <<EOF
ACCESS_DOMAIN=$ACCESS_DOMAIN
COOKIE_DOMAIN=.$ACCESS_DOMAIN
MANAGER_PUBLIC_URL=https://manager.$ACCESS_DOMAIN
WEBAUTHN_RP_ID=$ACCESS_DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
DATAPLANE_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 32)
AUDIT_RETENTION_DAYS=730
CAPTIVO_VERSION=$VERSION
EOF
  chmod 600 .env
else
  echo "→ Reusing existing .env (delete it to regenerate)."
  ACCESS_DOMAIN="$( . ./.env 2>/dev/null || true; echo "${ACCESS_DOMAIN:-<your-domain>}" )"
fi

echo "→ Pulling images + starting the stack (manager + data-plane + postgres + Caddy)..."
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d

remove_legacy_cron

cat <<EOF

✅ Captivo Access is starting.

DNS — point all three at this host's public IP (ports 80 + 443 open):
   manager.$ACCESS_DOMAIN
   connect.$ACCESS_DOMAIN
   *.$ACCESS_DOMAIN            (wildcard, for per-site vendor access)

Next steps:
1. Wait ~30s for Caddy to obtain certificates, then open:
     https://manager.$ACCESS_DOMAIN/
2. Complete first-run setup to create the initial admin (passkey).
3. Add a connector (/admin/connectors), a site (/admin/sites), then grant a vendor access.

Background jobs (health probes + audit/recording retention) run automatically in
the access-cron container — check them with: docker logs access-cron

Re-running ./setup.sh is safe — it reuses .env and re-applies the stack.
See README.md for the full reference, or ../docs/quickstart.md for a zero-DNS trial.
EOF
