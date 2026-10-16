#!/bin/sh
# Without arguments: the scheduler. BACKUP_SCHEDULE (cron, UTC) runs a
# backup; an hourly check catches up a missed or failed one. Any other
# command runs as given (`backup`, `restore …`, `sh`).
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh

if [ $# -gt 0 ] && [ "$1" != schedule ]; then exec "$@"; fi

schedule=${BACKUP_SCHEDULE:-0 3 * * *}
date -u +%s >/tmp/started
printf '%s backup\n17 * * * * backup --if-stale\n' "$schedule" >/tmp/crontab
if ! supercronic -test /tmp/crontab >/tmp/crontab.check 2>&1; then
  log error "BACKUP_SCHEDULE is not a valid cron expression" schedule="$schedule" detail="$(cat /tmp/crontab.check)"
  exit 2
fi
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then offsite=on; else offsite=off; fi
log info "backup scheduler started" schedule="$schedule" timezone=UTC \
  retention_days="${BACKUP_RETENTION_DAYS:-14}" offsite="$offsite" storage_driver="${STORAGE_DRIVER:-local}"
# -passthrough-logs: the jobs' JSON lines go out as they are.
exec supercronic -json -passthrough-logs /tmp/crontab
