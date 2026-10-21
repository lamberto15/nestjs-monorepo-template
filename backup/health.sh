#!/bin/sh
# The container's healthcheck: unhealthy when the last run failed, or when no
# backup has succeeded for BACKUP_MAX_AGE_HOURS plus an hour (the hourly
# catch-up had its chance). Before the first backup, counted from the start.
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh

max_hours=${BACKUP_MAX_AGE_HOURS:-25}
require_number BACKUP_MAX_AGE_HOURS "$max_hours"
now=$(date -u +%s)
ok=$(last_success)
failed=$(last_failure)

if [ "$failed" -gt "$ok" ]; then
  echo "the last backup failed at $(date -u -d "@$failed" +%Y-%m-%dT%H:%M:%SZ): docker compose logs backup"
  exit 1
fi
since=$ok
if [ "$since" -eq 0 ] && [ -s /tmp/started ]; then since=$(cat /tmp/started); fi
if [ $((now - since)) -gt $(((max_hours + 1) * 3600)) ]; then
  echo "no successful backup for more than $max_hours hours: docker compose logs backup"
  exit 1
fi
# Point-in-time recovery with an off-host copy: wal-ship.sh runs every minute and
# leaves a marker each pass; half an hour without one means the segments
# are piling up on the host only.
if pitr_on && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  wal_ok=0
  if [ -s "$BACKUP_DIR/.wal-last-success" ]; then wal_ok=$(cat "$BACKUP_DIR/.wal-last-success"); fi
  wal_since=$wal_ok
  if [ "$wal_since" -eq 0 ] && [ -s /tmp/started ]; then wal_since=$(cat /tmp/started); fi
  if [ $((now - wal_since)) -gt 1800 ]; then
    echo "the WAL archive was not sent off the host for more than 30 minutes: docker compose logs backup"
    exit 1
  fi
fi
echo "ok: last backup $(if [ "$ok" -eq 0 ]; then echo none yet; else date -u -d "@$ok" +%Y-%m-%dT%H:%M:%SZ; fi)"
