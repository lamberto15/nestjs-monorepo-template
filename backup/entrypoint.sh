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
# Point-in-time recovery: the WAL archive's segments go off the host every
# minute (wal-ship.sh), encrypted like the rest. Without a bucket they stay
# in the archive volume only.
if pitr_on; then
  if [ ! -d "$WAL_DIR" ]; then
    log error "BACKUP_PITR=on, but the WAL archive is not mounted at $WAL_DIR: add compose.pitr.yaml to COMPOSE_FILE"
    exit 2
  fi
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then printf '* * * * * backup-wal-ship\n' >>/tmp/crontab; fi
fi
if ! supercronic -test /tmp/crontab >/tmp/crontab.check 2>&1; then
  log error "BACKUP_SCHEDULE is not a valid cron expression" schedule="$schedule" detail="$(cat /tmp/crontab.check)"
  exit 2
fi
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then offsite=on; else offsite=off; fi
log info "backup scheduler started" schedule="$schedule" timezone=UTC \
  retention_days="${BACKUP_RETENTION_DAYS:-14}" offsite="$offsite" storage_driver="${STORAGE_DRIVER:-local}" \
  pitr="$(if pitr_on; then echo on; else echo off; fi)" encryption="$(if encryption_on; then echo on; else echo off; fi)"
# A fresh stack has no backup until BACKUP_SCHEDULE fires, up to a day away:
# take one now when the volume has none, or the newest is older than
# BACKUP_MAX_AGE_HOURS (the hourly catch-up does the same, but at :17). It
# waits for the database first, so a stack starting together is not logged as
# a failed backup, and runs beside the scheduler, which flock keeps from
# overlapping it.
(
  tries=0
  until pg_isready -q || [ "$tries" -ge 60 ]; do
    tries=$((tries + 1))
    sleep 5
  done
  backup --if-stale || true
) &
# -passthrough-logs: the jobs' JSON lines go out as they are.
exec supercronic -json -passthrough-logs /tmp/crontab
