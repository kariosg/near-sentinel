#!/usr/bin/env bash
# NEAR Sentinel: build and run the production stack. Run as the deploy user (NOT root) on the server.
#
#   bash deploy/vultr/deploy.sh [command]
#
# Commands:
#   deploy    (default) clone if needed, build, start, wait for health, print status
#   update    git pull (fast-forward only) on $BRANCH, then deploy
#   rollback  re-deploy the commit that was live before the last update/deploy (detached HEAD)
#   status    container status + health checks
#   logs      follow logs (Ctrl+C to stop). Extra args go to `docker compose logs`, e.g. `logs caddy`
#   down      stop and remove the containers (volumes, i.e. data and certificates, are KEPT)
#
# Options (environment variables):
#   REPO_URL=<REPO_URL>          only needed if the repo is not cloned yet
#   APP_DIR=$HOME/near-sentinel  where the repo lives (default: the repo containing this script)
#   BRANCH=master                branch used by `update`
set -euo pipefail

BRANCH="${BRANCH:-master}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${APP_DIR:-}" ]]; then
  if git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
    APP_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
  else
    APP_DIR="$HOME/near-sentinel"
  fi
fi
COMPOSE_FILE="deploy/vultr/docker-compose.prod.yml"
ENV_FILE="deploy/vultr/.env.production"
HISTORY_FILE="$APP_DIR/.git/sentinel-deploy-history"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARNING: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] || warn "Running as root. Prefer the deploy user (e.g. sentinel)."
command -v docker >/dev/null 2>&1 || die "docker not found. Run setup-server.sh first."
docker info >/dev/null 2>&1 || die "Cannot talk to Docker. Is this user in the docker group? (log out and back in after setup-server.sh)"

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Read one KEY=value from the env file without executing it.
env_value() { grep -E "^$1=" "$APP_DIR/$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"'"'"'\r'; }

ensure_repo() {
  if [[ ! -d "$APP_DIR/.git" ]]; then
    [[ -n "${REPO_URL:-}" ]] || die "No repo at $APP_DIR. Set REPO_URL=<REPO_URL> (or clone it yourself) and re-run."
    step "Cloning into $APP_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  cd "$APP_DIR"
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die "Missing $APP_DIR/$ENV_FILE.
       cp deploy/vultr/env.production.example $ENV_FILE && nano $ENV_FILE"
  fi
  if grep -qE '^SENTINEL_DOMAIN=sentinel\.example\.com' "$ENV_FILE"; then
    die "$ENV_FILE still has the example SENTINEL_DOMAIN. Set your own hostname."
  fi
  if grep -qiE '(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}' "$ENV_FILE"; then
    die "$ENV_FILE appears to contain a private key. Remove it: no keys ever go on this server."
  fi
  chmod 600 "$ENV_FILE"
}

record_live_commit() {
  local head
  head="$(git rev-parse HEAD)"
  if [[ ! -f "$HISTORY_FILE" ]] || [[ "$(tail -n1 "$HISTORY_FILE")" != "$head" ]]; then
    echo "$head" >> "$HISTORY_FILE"
  fi
}

wait_healthy() {
  step "Waiting for the app to become healthy"
  local id status i
  id="$(dc ps -q sentinel)"
  [[ -n "$id" ]] || die "sentinel container is not running. See: bash deploy/vultr/deploy.sh logs sentinel"
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo unknown)"
    if [[ "$status" == "healthy" ]]; then
      info "sentinel: healthy"
      return 0
    fi
    [[ "$status" == "unhealthy" ]] && break
    [[ $((i % 5)) -eq 0 ]] && info "still $status (${i}x2s)"
    sleep 2
  done
  dc logs --tail 50 sentinel || true
  die "sentinel did not become healthy (status: $status)."
}

show_status() {
  step "Containers"
  dc ps
  step "Checks through Caddy"
  local domain http_port https_port
  domain="$(env_value SENTINEL_DOMAIN)"
  http_port="$(env_value HTTP_PORT)"; http_port="${http_port:-80}"
  https_port="$(env_value HTTPS_PORT)"; https_port="${https_port:-443}"
  if [[ "$domain" == :* ]]; then
    if curl -fsS --max-time 10 "http://127.0.0.1:${http_port}/health"; then
      echo
      info "HTTP fallback mode (temporary, not encrypted): http://<server-ip>/"
    else
      warn "Caddy did not answer on http://127.0.0.1:${http_port}/health yet. Check: deploy.sh logs caddy"
    fi
  else
    if curl -fsS --max-time 15 --resolve "${domain}:${https_port}:127.0.0.1" "https://${domain}:${https_port}/health"; then
      echo
      info "Live at https://${domain}/  (dashboard), https://${domain}/docs (API docs)"
    else
      warn "HTTPS check failed. The certificate may still be issuing (up to a minute or two) or DNS"
      warn "for ${domain} does not point at this server yet. Watch: bash deploy/vultr/deploy.sh logs caddy"
    fi
  fi
  info "Deployed commit: $(git -C "$APP_DIR" log -1 --format='%h %s')"
}

do_deploy() {
  ensure_repo
  ensure_env
  step "Building and starting (first build takes several minutes)"
  dc up -d --build --remove-orphans
  wait_healthy
  record_live_commit
  show_status
}

cmd="${1:-deploy}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  deploy)
    do_deploy
    ;;
  update)
    ensure_repo
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "Tracked files have local changes on the server; commit or stash them first (git status)."
    record_live_commit
    step "Pulling $BRANCH"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull --ff-only origin "$BRANCH"
    do_deploy
    ;;
  rollback)
    ensure_repo
    [[ -f "$HISTORY_FILE" ]] || die "No deploy history yet."
    current="$(git rev-parse HEAD)"
    previous="$(grep -v "^${current}$" "$HISTORY_FILE" | tail -n1 || true)"
    [[ -n "$previous" ]] || die "No earlier deployed commit recorded."
    step "Rolling back to $(git log -1 --format='%h %s' "$previous")"
    warn "Detached HEAD. Return to the latest code later with: bash deploy/vultr/deploy.sh update"
    git checkout --detach "$previous"
    do_deploy
    ;;
  status)
    ensure_repo
    show_status
    ;;
  logs)
    ensure_repo
    dc logs -f --tail 200 "$@"
    ;;
  down)
    ensure_repo
    step "Stopping containers (data and certificate volumes are kept)"
    dc down
    ;;
  -h|--help|help)
    sed -n '2,18p' "$0"
    ;;
  *)
    die "Unknown command: $cmd (try: deploy | update | rollback | status | logs | down)"
    ;;
esac
