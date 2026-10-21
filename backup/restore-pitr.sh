#!/bin/sh
# Point-in-time recovery (docs/deployment.md, "Point-in-time recovery"):
# prepares a PostgreSQL data directory from a base backup (BACKUP_PITR=on)
# and the WAL archive, set to replay up to a moment and then open for writes.
#
#   restore-pitr base-<time>.tar.gz[.age] --pgdata DIR [--target-time TIME] [--offsite] [--wal-dir DIR]
#
#   --pgdata DIR       the new data directory (must be empty or missing); mount
#                      the PostgreSQL data volume here, and start the server on it
#   --target-time T    stop replaying at T, e.g. '2026-10-21 09:30:00+00'
#                      (before the mistake); without it, replay all the archive holds
#   --offsite          take the WAL from the bucket (a new host), not from BACKUP_WAL_DIR
#   --wal-dir DIR      where the WAL goes for the recovery (default /restore/wal): the
#                      server must see it at this same path (restore_command reads it)
#
# The base backup is looked up in /backups like `restore`; encrypted ones
# need BACKUP_DECRYPTION_KEY(_FILE). Run it as root (`--user root`) so the
# files keep the server's owner. Nothing here touches a running database.
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh
umask 077

usage() {
  echo "usage: restore-pitr base-<time>.tar.gz[.age] --pgdata DIR [--target-time TIME] [--offsite] [--wal-dir DIR]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
base=$1
shift
pgdata=''
target=''
offsite=off
recovery_wal=/restore/wal
while [ $# -gt 0 ]; do
  case $1 in
    --pgdata)
      pgdata=${2:?--pgdata needs a directory}
      shift 2
      ;;
    --target-time)
      target=${2:?--target-time needs a time}
      shift 2
      ;;
    --wal-dir)
      recovery_wal=${2:?--wal-dir needs a directory}
      shift 2
      ;;
    --offsite)
      offsite=on
      shift
      ;;
    *) usage ;;
  esac
done
[ -n "$pgdata" ] || usage
case $base in /*) ;; *) base="$BACKUP_DIR/$base" ;; esac
name=$(basename "$base")
if [ ! -f "$base" ]; then
  echo "No such base backup: $base (docker compose exec backup ls -l /backups)" >&2
  exit 1
fi
if [ -f "$base.sha256" ] && ! (cd "$(dirname "$base")" && sha256sum -c "$name.sha256" >/dev/null 2>&1); then
  echo "Checksum mismatch: $base is damaged" >&2
  exit 1
fi
if [ -d "$pgdata" ] && [ -n "$(ls -A "$pgdata")" ]; then
  echo "$pgdata is not empty: move the old data directory aside first (docs/deployment.md)" >&2
  exit 1
fi

trap 'if [ -n "${IDENTITY_TMP:-}" ]; then rm -f "$IDENTITY_TMP"; fi' EXIT
encrypted=off
case $name in *.age)
  encrypted=on
  age_identity
  ;;
esac

started=$(date -u +%s)
log info "pitr restore started" base="$name" pgdata="$pgdata" target_time="${target:-latest}"

# 1. The base backup.
mkdir -p "$pgdata"
chmod 700 "$pgdata"
if [ "$encrypted" = on ]; then
  age --decrypt --identity "$IDENTITY" "$base" | tar -xz -C "$pgdata" --numeric-owner
else
  tar -xzf "$base" -C "$pgdata" --numeric-owner
fi

# 2. The WAL: from the volume, or the bucket (decrypted segment by segment,
# since restore_command only copies).
mkdir -p "$recovery_wal"
if [ "$offsite" = on ]; then
  offsite_setup
  rclone copy --quiet "$OFFSITE/wal" "$recovery_wal"
  for f in "$recovery_wal"/*.age; do
    [ -e "$f" ] || continue
    age --decrypt --identity "$IDENTITY" --output "${f%.age}" "$f"
    rm -f "$f"
  done
else
  if [ ! -d "$WAL_DIR" ]; then
    echo "No WAL archive at $WAL_DIR (--offsite takes it from the bucket)" >&2
    exit 1
  fi
  for f in "$WAL_DIR"/*; do
    [ -f "$f" ] && cp -p "$f" "$recovery_wal"/
  done
fi

# 3. Recovery settings: PostgreSQL's documented way (continuous archiving,
# "Recovering Using a Continuous Archive Backup"): restore_command, an optional
# target, and an empty recovery.signal. At the target the server promotes
# itself (a new timeline), so it accepts writes at once.
{
  echo "restore_command = 'cp $recovery_wal/%f \"%p\"'"
  if [ -n "$target" ]; then echo "recovery_target_time = '$target'"; fi
  echo "recovery_target_action = 'promote'"
} >>"$pgdata/postgresql.auto.conf"
: >"$pgdata/recovery.signal"

# The server's user owns the data directory (when run as root).
if [ "$(id -u)" = 0 ]; then
  chown -R postgres:postgres "$pgdata" "$recovery_wal"
fi
log info "pitr restore prepared: start PostgreSQL on the data directory; it replays the WAL, then opens" \
  base="$name" pgdata="$pgdata" wal="$recovery_wal" target_time="${target:-latest}" seconds=$(($(date -u +%s) - started))
