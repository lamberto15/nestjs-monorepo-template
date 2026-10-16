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
echo "ok: last backup $(if [ "$ok" -eq 0 ]; then echo none yet; else date -u -d "@$ok" +%Y-%m-%dT%H:%M:%SZ; fi)"
