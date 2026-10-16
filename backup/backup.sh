#!/bin/sh
# One backup run (the scheduler calls it; `docker compose exec backup backup`
# runs one now):
#   1. pg_dump of the database (custom format, compressed), checked by
#      reading its table of contents back;
#   2. the uploaded files (STORAGE_DRIVER=local) as a tar.gz;
#   3. a .sha256 next to each, then a copy of each off the host when
#      BACKUP_S3_BUCKET is set;
#   4. local files older than BACKUP_RETENTION_DAYS removed.
# Exits non-zero on any failure, logged as one JSON error line; the
# healthcheck then reports unhealthy until a run succeeds.
#
#   backup              run now
#   backup --if-stale   run only if the last run failed or the newest
#                       successful backup is older than BACKUP_MAX_AGE_HOURS
#                       (hourly: catches up after a missed schedule)
#
# The connection comes from libpq's variables (PGHOST, PGUSER, PGPASSWORD,
# PGDATABASE), so the password never appears in a command line.
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh
# The dumps hold everything (password hashes, keys kept in app_secrets): owner only.
umask 077

STORAGE_DIR=${BACKUP_STORAGE_DIR:-/storage}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-25}
require_number BACKUP_RETENTION_DAYS "$RETENTION_DAYS"
require_number BACKUP_MAX_AGE_HOURS "$MAX_AGE_HOURS"

mode=${1:-now}
case $mode in
  now | --if-stale) ;;
  *)
    echo "usage: backup [--if-stale]" >&2
    exit 2
    ;;
esac

# One run at a time (the schedule, the hourly check, a manual run). The lock
# goes with the process, so a killed run leaves none behind.
exec 9>"$BACKUP_DIR/.lock"
if ! flock -n 9; then
  if [ "$mode" = --if-stale ]; then exit 0; fi
  log error "backup failed: another backup is running"
  exit 1
fi

if [ "$mode" = --if-stale ]; then
  ok=$(last_success)
  failed=$(last_failure)
  age=$(($(date -u +%s) - ok))
  if [ "$failed" -le "$ok" ] && [ "$age" -le $((MAX_AGE_HOURS * 3600)) ]; then exit 0; fi
  log info "catching up: the last backup failed or is older than BACKUP_MAX_AGE_HOURS" max_age_hours="$MAX_AGE_HOURS"
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
started=$(date -u +%s)
db_file="db-$stamp.dump"
files_file="files-$stamp.tar.gz"
step=start

finish() {
  code=$?
  # Half-written files of this run never count as backups.
  rm -f "$BACKUP_DIR/.partial-$db_file" "$BACKUP_DIR/.partial-$files_file"
  if [ "$code" -ne 0 ]; then
    date -u +%s >"$BACKUP_DIR/.last-failure"
    log error "backup failed" step="$step" exit_code="$code" database="${PGDATABASE:-}"
  fi
}
trap finish EXIT
trap 'exit 143' TERM INT

log info "backup started" database="${PGDATABASE:-}" host="${PGHOST:-}"
cd "$BACKUP_DIR"
# Left by a run killed mid-way (the lock is ours, so none is being written).
rm -f .partial-*

# 1. The database: one consistent snapshot (pg_dump runs in a single
# repeatable-read transaction), so the app keeps running meanwhile.
step=dump
pg_dump --format=custom --file=".partial-$db_file"
step=verify
toc=$(pg_restore --list ".partial-$db_file")
objects=$(printf '%s\n' "$toc" | grep -vc '^;' || true)
mv ".partial-$db_file" "$db_file"
sha256sum "$db_file" >"$db_file.sha256"
made="$db_file $db_file.sha256"
db_bytes=$(wc -c <"$db_file" | tr -d ' ')

# 2. Uploaded files, after the dump: every file a dumped row points to is in
# the archive (files added meanwhile are orphans the app's sweep removes).
files='skipped'
if [ "${STORAGE_DRIVER:-local}" = local ]; then
  step=files
  if [ ! -d "$STORAGE_DIR" ]; then
    echo "STORAGE_DRIVER=local, but the files volume is not mounted at $STORAGE_DIR" >&2
    exit 1
  fi
  tar -czf ".partial-$files_file" -C "$STORAGE_DIR" .
  gzip -t ".partial-$files_file"
  mv ".partial-$files_file" "$files_file"
  sha256sum "$files_file" >"$files_file.sha256"
  made="$made $files_file $files_file.sha256"
  files=$files_file
fi

# 3. Off the host (the bucket must exist).
offsite='off'
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  step=upload
  offsite_setup
  for name in $made; do
    # Names carry the time, so never overwrite; rclone checks each upload.
    rclone copyto --quiet --no-check-dest "$name" "$OFFSITE/$name"
  done
  offsite=$OFFSITE_URL
fi

# 4. Retention: only after a complete run, so failures never thin the backups out.
step=prune
pruned=$(find . -maxdepth 1 -type f \( -name 'db-*' -o -name 'files-*' \) -mtime +"$RETENTION_DAYS" \
  -print -exec rm -f {} + | wc -l | tr -d ' ')

step=finished
date -u +%s >"$BACKUP_DIR/.last-success"
log info "backup done" file="$db_file" bytes="$db_bytes" objects="$objects" files="$files" \
  offsite="$offsite" pruned="$pruned" seconds=$(($(date -u +%s) - started))
