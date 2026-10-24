#!/bin/sh
# One backup run (the scheduler calls it; `docker compose exec backup backup`
# runs one now):
#   1. pg_dump of the database (custom format, compressed), checked by
#      reading its table of contents back;
#   2. the uploaded files (STORAGE_DRIVER=local) as a tar.gz;
#   3. with BACKUP_PITR=on (compose.pitr.yaml), a base backup of the cluster
#      (pg_basebackup), the starting point for point-in-time recovery with
#      the WAL archive (wal-ship.sh sends the segments off the host);
#   4. each encrypted with age when BACKUP_ENCRYPTION_KEY is set (.age), a
#      .sha256 next to each, then a copy of each off the host when
#      BACKUP_S3_BUCKET is set;
#   5. local files older than BACKUP_RETENTION_DAYS removed (and the WAL
#      archive before the oldest base backup kept).
# Exits non-zero on any failure, logged as one JSON error line; the
# healthcheck then reports unhealthy until a run succeeds.
#
#   backup              run now
#   backup --if-stale   run only if the last run failed or the newest
#                       successful backup is older than BACKUP_MAX_AGE_HOURS
#                       (hourly, and once when the container starts: catches up
#                       after a missed schedule, and gives a new stack its first)
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
base_file="base-$stamp.tar.gz"
step=start

# seal <partial file> <final name>: the finished file becomes the backup:
# encrypted (the plaintext removed) when BACKUP_ENCRYPTION_KEY is set, then
# its checksum. Sets sealed to the name it was kept under.
seal() {
  if encryption_on; then
    age_encrypt "$1" ".partial-$2.age"
    rm -f "$1"
    mv ".partial-$2.age" "$2.age"
    sealed="$2.age"
  else
    mv "$1" "$2"
    sealed=$2
  fi
  sha256sum "$sealed" >"$sealed.sha256"
  made="$made $sealed $sealed.sha256"
}

finish() {
  code=$?
  if [ -n "${snapshot_pid:-}" ]; then kill "$snapshot_pid" 2>/dev/null || true; wait "$snapshot_pid" 2>/dev/null || true; fi
  rm -f "$BACKUP_DIR"/.snapshot-*
  # Half-written files of this run never count as backups.
  rm -f "$BACKUP_DIR"/.partial-*
  if [ "$code" -ne 0 ]; then
    date -u +%s >"$BACKUP_DIR/.last-failure"
    log error "backup failed" step="$step" exit_code="$code" database="${PGDATABASE:-}"
  fi
}
trap finish EXIT
trap 'exit 143' TERM INT

log info "backup started" database="${PGDATABASE:-}" host="${PGHOST:-}"
cd "$BACKUP_DIR"
made=''
if pitr_on && [ ! -d "$WAL_DIR" ]; then
  echo "BACKUP_PITR=on, but the WAL archive is not mounted at $WAL_DIR (compose.pitr.yaml)" >&2
  exit 1
fi
# Left by a run killed mid-way (the lock is ours, so none is being written).
rm -f .partial-*

# Hold an exported PostgreSQL snapshot open for the dump and file manifest.
step=snapshot
snapshot_file="$BACKUP_DIR/.snapshot-$stamp"
psql --no-psqlrc --tuples-only --quiet -v ON_ERROR_STOP=1 >"$snapshot_file" <<'SQL' &
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();
SELECT pg_sleep(3600);
SQL
snapshot_pid=$!
n=0
while [ ! -s "$snapshot_file" ] && kill -0 "$snapshot_pid" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
snapshot=$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$snapshot_file")
case $snapshot in *[!0-9A-Fa-f-]* | '') echo "could not export PostgreSQL snapshot" >&2; exit 1 ;; esac
# 1. The database and manifest use the exact same snapshot while the app runs.
step=dump
pg_dump --snapshot="$snapshot" --format=custom --file=".partial-$db_file"
step=verify
toc=$(pg_restore --list ".partial-$db_file")
objects=$(printf '%s\n' "$toc" | grep -vc '^;' || true)
# 2. Uploaded files, checked against snapshot-consistent persisted references.
files='skipped'
if [ "${STORAGE_DRIVER:-local}" = local ]; then
  step=files
  if [ ! -d "$STORAGE_DIR" ]; then
    echo "STORAGE_DRIVER=local, but the files volume is not mounted at $STORAGE_DIR" >&2
    exit 1
  fi
  step=manifest
  psql --no-psqlrc --tuples-only --no-align --quiet --single-transaction -v ON_ERROR_STOP=1 >".partial-files-$stamp.manifest" <<SQL
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '$snapshot';
\copy (SELECT key FROM attachments UNION SELECT r.value->>'key' FROM attachments a CROSS JOIN LATERAL jsonb_each(COALESCE(a.renditions, '{}'::jsonb)) r UNION SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL UNION SELECT logo_key FROM tenants WHERE logo_key IS NOT NULL UNION SELECT 'legacy_logo:' || 'tenants/' || id::text || '/branding/logo' FROM tenants WHERE logo_key IS NULL) TO STDOUT
SQL
  # Old logos used a fixed key without a database pointer. Include those that
  # exist; current uploads always have the persisted logo_key above.
  mv ".partial-files-$stamp.manifest" ".partial-files-$stamp.raw"
  while IFS= read -r key; do
    case $key in
      legacy_logo:*) key=${key#legacy_logo:}; [ -f "$STORAGE_DIR/$key" ] || continue ;;
    esac
    printf '%s\n' "$key"
  done <".partial-files-$stamp.raw" >".partial-files-$stamp.manifest"
  rm -f ".partial-files-$stamp.raw"
  tar -czf ".partial-$files_file" -C "$STORAGE_DIR" .
  gzip -t ".partial-$files_file"
  step=validate-files
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if ! tar -tzf ".partial-$files_file" "./$key" >/dev/null 2>&1; then
      echo "referenced file missing from backup archive: $key" >&2
      exit 1
    fi
  done <".partial-files-$stamp.manifest"
  rm -f ".partial-files-$stamp.manifest"
  seal ".partial-$files_file" "$files_file"
  files=$sealed
fi

# The dump and manifest have both imported it; do not hold an old database
# snapshot open during archive compression, upload or retention.
kill "$snapshot_pid" 2>/dev/null || true
wait "$snapshot_pid" 2>/dev/null || true
snapshot_pid=''

# Seal the database only after local file references have passed validation.
step=seal
seal ".partial-$db_file" "$db_file"
db_file=$sealed
db_bytes=$(wc -c <"$db_file" | tr -d ' ')

# 2b. Point-in-time recovery: a base backup of the whole cluster. WAL from its
# start on (kept in the archive, shipped off the host) replays it to any moment
# after it. No WAL in the backup itself (--wal-method=none): the archive has
# it, and pg_basebackup returns once the last segment it needs is archived.
# Needs the replication line of pg_hba.pitr.conf. One tar on stdout, so a
# cluster with extra tablespaces fails here, loudly.
base='skipped'
if pitr_on; then
  step=basebackup
  pg_basebackup --pgdata=- --format=tar --gzip --wal-method=none --checkpoint=fast \
    --label="base-$stamp" >".partial-$base_file"
  gzip -t ".partial-$base_file"
  # The first WAL segment the base backup needs, from its backup_label.
  walstart=$(tar -xzOf ".partial-$base_file" backup_label | sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]\{24\}\))$/\1/p')
  if [ -z "$walstart" ]; then
    echo "the base backup holds no backup_label with a start segment" >&2
    exit 1
  fi
  printf '%s\n' "$walstart" >".partial-base-$stamp.walstart"
  mv ".partial-base-$stamp.walstart" "base-$stamp.walstart"
  made="$made base-$stamp.walstart"
  step=seal
  seal ".partial-$base_file" "$base_file"
  base=$sealed
fi

# 3. Off the host (the bucket must exist). Everything here is already encrypted
# when BACKUP_ENCRYPTION_KEY is set (rclone's own crypt isn't used).
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
pruned=$(find . -maxdepth 1 -type f \( -name 'db-*' -o -name 'files-*' -o -name 'base-*' \) -mtime +"$RETENTION_DAYS" \
  -print -exec rm -f {} + | wc -l | tr -d ' ')
# The WAL archive: segments older than the oldest base backup kept can never
# be replayed from. (This run's base backup exists, so there is always one.)
if pitr_on; then
  step=prune-wal
  oldest=$(cat $(ls base-*.walstart | sort | head -n 1))
  pg_archivecleanup "$WAL_DIR" "$oldest"
fi

step=finished
date -u +%s >"$BACKUP_DIR/.last-success"
log info "backup done" file="$db_file" bytes="$db_bytes" objects="$objects" files="$files" \
  base="$base" encrypted="$(if encryption_on; then echo on; else echo off; fi)" offsite="$offsite" pruned="$pruned" seconds=$(($(date -u +%s) - started))
