#!/usr/bin/env bash
# NEAR Sentinel: online backup of the SQLite database to a timestamped tarball.
# Run as the deploy user on the server, from anywhere:
#
#   bash deploy/vultr/backup.sh            -> $BACKUP_DIR/sentinel-YYYYmmdd-HHMMSS.tar.gz
#
# Uses SQLite's VACUUM INTO inside the running container, so the copy is consistent even while the app writes.
# Options: BACKUP_DIR (default: $HOME/sentinel-backups). Old backups are never deleted by this script.
# Restore: see docs/deployment/VULTR.md ("Backups").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../.." && pwd))"
BACKUP_DIR="${BACKUP_DIR:-$HOME/sentinel-backups}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SNAP="/data/.backup-${STAMP}.db"

cd "$APP_DIR"
dc() { docker compose -f deploy/vultr/docker-compose.prod.yml --env-file deploy/vultr/.env.production "$@"; }

[[ -n "$(dc ps -q sentinel)" ]] || { echo "sentinel is not running; start it with deploy.sh first." >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  dc exec -T -e SNAP="$SNAP" sentinel node -e "require('fs').rmSync(process.env.SNAP, { force: true })" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Snapshotting /data/sentinel.db (VACUUM INTO)"
dc exec -T -e SNAP="$SNAP" sentinel node --no-warnings -e \
  "const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync('/data/sentinel.db'); d.prepare('VACUUM INTO ?').run(process.env.SNAP); d.close()"

echo "==> Copying out and compressing"
dc cp "sentinel:$SNAP" "$WORK/sentinel.db"
tar -C "$WORK" -czf "$BACKUP_DIR/sentinel-${STAMP}.tar.gz" sentinel.db
chmod 600 "$BACKUP_DIR/sentinel-${STAMP}.tar.gz"

echo "==> Backup written: $BACKUP_DIR/sentinel-${STAMP}.tar.gz ($(du -h "$BACKUP_DIR/sentinel-${STAMP}.tar.gz" | cut -f1))"
