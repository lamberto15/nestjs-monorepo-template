#!/bin/sh
# Sends the WAL archive's new segments off the host (BACKUP_PITR=on and
# BACKUP_S3_BUCKET set; the scheduler runs it every minute). PostgreSQL's
# archive_command (compose.pitr.yaml) puts each finished segment in
# BACKUP_WAL_DIR; this copies it to <bucket>/<prefix>/wal/, encrypted with age
# when BACKUP_ENCRYPTION_KEY is set (<name>.age), and leaves a marker in
# .shipped/ so it is sent once. Segments stay in the archive until a backup
# run prunes the ones no base backup needs. Exits non-zero on a failure
# (logged as one JSON line); the next minute tries again.
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh
umask 077

if ! pitr_on; then
  log error "wal-ship: BACKUP_PITR is not on"
  exit 2
fi
offsite_setup
mkdir -p "$WAL_DIR/.shipped"

# One pass at a time.
exec 8>"$BACKUP_DIR/.wal-lock"
if ! flock -n 8; then exit 0; fi

tmp="$BACKUP_DIR/.partial-wal"
trap 'rm -f "$tmp"' EXIT

shipped=0
for path in "$WAL_DIR"/*; do
  [ -f "$path" ] || continue
  name=${path##*/}
  [ -e "$WAL_DIR/.shipped/$name" ] && continue
  if encryption_on; then
    age_encrypt "$path" "$tmp"
    remote="$name.age"
    source=$tmp
  else
    remote=$name
    source=$path
  fi
  if ! rclone copyto --quiet --no-check-dest "$source" "$OFFSITE/wal/$remote"; then
    date -u +%s >"$BACKUP_DIR/.wal-last-failure"
    log error "wal-ship failed" file="$name"
    exit 1
  fi
  : >"$WAL_DIR/.shipped/$name"
  shipped=$((shipped + 1))
done

# Markers of segments pruned from the archive.
for marker in "$WAL_DIR"/.shipped/*; do
  [ -e "$marker" ] || continue
  [ -e "$WAL_DIR/${marker##*/}" ] || rm -f "$marker"
done

date -u +%s >"$BACKUP_DIR/.wal-last-success"
if [ "$shipped" -gt 0 ]; then log info "wal shipped" files="$shipped" offsite="$OFFSITE_URL"wal/; fi
