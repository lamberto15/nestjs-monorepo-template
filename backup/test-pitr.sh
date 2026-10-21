#!/bin/sh
# End-to-end test of the backup scripts' encryption and point-in-time
# recovery, against a throwaway PostgreSQL in a temporary directory (no
# Docker needed inside; CI runs it in the backup image: scripts/test-backup-pitr.sh):
#
#   dump and base backup encrypted -> WAL archived and "shipped" (a stand-in
#   for rclone, so no bucket is needed) -> the plaintext never reaches the
#   "bucket" -> restore-pitr to a moment between two rows -> restore of the
#   encrypted dump.
#
# Needs initdb, pg_ctl, psql, pg_basebackup, pg_archivecleanup, age,
# age-keygen, flock and the scripts installed as in the image
# (/usr/local/lib/backup/lib.sh, backup, restore, restore-pitr, backup-wal-ship).
set -eu

# initdb refuses to run as root (the image runs as postgres; elsewhere, drop to it).
if [ "$(id -u)" = 0 ]; then exec runuser -u postgres -- sh "$0" "$@"; fi

T=$(mktemp -d)
trap 'pg_ctl -D "$T/pgdata" -m immediate stop >/dev/null 2>&1 || true; pg_ctl -D "$T/restored" -m immediate stop >/dev/null 2>&1 || true; rm -r "$T"' EXIT
failures=0
ok() { echo "ok    $1"; }
bad() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}
check() { # check <name> <command…>
  name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

mkdir "$T/sock" "$T/wal" "$T/backups" "$T/bin" "$T/bucket"
export PGHOST=$T/sock PGPORT=55432 PGUSER=postgres PGDATABASE=postgres
export BACKUP_DIR=$T/backups BACKUP_WAL_DIR=$T/wal BACKUP_PITR=on STORAGE_DRIVER=s3
export BACKUP_S3_BUCKET=bk BACKUP_S3_PREFIX=test

# The archive_command of compose.pitr.yaml, with this test's directory.
initdb -D "$T/pgdata" -U postgres --auth=trust >/dev/null
cat >>"$T/pgdata/postgresql.conf" <<CONF
listen_addresses = ''
port = $PGPORT
unix_socket_directories = '$T/sock'
archive_mode = on
archive_command = 'test ! -f $T/wal/%f && cp %p $T/wal/.%f.tmp && mv $T/wal/.%f.tmp $T/wal/%f'
CONF
pg_ctl -D "$T/pgdata" -w -l "$T/pg.log" start >/dev/null

# A stand-in for rclone: "offsite:bk/test/x" is $T/bucket/bk/test/x.
cat >"$T/bin/rclone" <<'SHIM'
#!/bin/sh
shift_quiet() { :; }
args=''
for a in "$@"; do case $a in --*) ;; *) args="$args $a" ;; esac; done
set -- $args
cmd=$1
src=$2
dst=$3
map() { case $1 in offsite:*) echo "$BUCKET_DIR/${1#offsite:}" ;; *) echo "$1" ;; esac; }
case $cmd in
  copyto) mkdir -p "$(dirname "$(map "$dst")")" && cp "$(map "$src")" "$(map "$dst")" ;;
  copy) mkdir -p "$(map "$dst")" && cp "$(map "$src")"/* "$(map "$dst")"/ ;;
  *) exit 1 ;;
esac
SHIM
chmod +x "$T/bin/rclone"
# restore.sh uses busybox's `sha256sum -c -s`; GNU's spelling is --status.
if sha256sum --version >/dev/null 2>&1; then
  printf '#!/bin/sh\nfor a in "$@"; do if [ "$a" = -s ]; then a=--status; fi; set -- "$@" "$a"; shift; done\nexec /usr/bin/sha256sum "$@"\n' >"$T/bin/sha256sum"
  chmod +x "$T/bin/sha256sum"
fi
export BUCKET_DIR=$T/bucket PATH="$T/bin:$PATH"

age-keygen -o "$T/identity" >/dev/null 2>&1
export BACKUP_ENCRYPTION_KEY=$(age-keygen -y "$T/identity")
export BACKUP_DECRYPTION_KEY_FILE=$T/identity

q() { psql --no-psqlrc -At -v ON_ERROR_STOP=1 -c "$1"; }
archived() { q "select archived_count from pg_stat_archiver"; }
wait_archived() { # wait_archived <count before>
  n=0
  while [ "$(archived)" -le "$1" ] && [ "$n" -lt 60 ]; do
    n=$((n + 1))
    sleep 0.5
  done
}

q "create table t (v text)"
q "insert into t values ('A')"

backup >"$T/backup.log" 2>&1 || { cat "$T/backup.log" >&2; bad "backup runs"; }
check "dump and base backup are encrypted, with checksums" sh -c \
  "ls '$T'/backups/db-*.dump.age '$T'/backups/base-*.tar.gz.age '$T'/backups/db-*.dump.age.sha256 >/dev/null"
check "no plaintext backup is kept" sh -c "! ls '$T'/backups | grep -E '^(db-.*\.dump|base-.*\.tar\.gz|.partial-)' | grep -v '\.age'"
check "the base backup records its first WAL segment" sh -c "grep -Eq '^[0-9A-F]{24}$' '$T'/backups/base-*.walstart"
check "the encrypted dump is not readable without the identity" sh -c "! pg_restore --list '$T'/backups/db-*.dump.age >/dev/null 2>&1"

q "insert into t values ('B')"
target=$(q "select clock_timestamp()")
sleep 2
q "insert into t values ('C')"
before=$(archived)
q "select pg_switch_wal()" >/dev/null
wait_archived "$before"

backup-wal-ship >"$T/ship.log" 2>&1 || { cat "$T/ship.log" >&2; bad "wal-ship runs"; }
check "WAL segments reach the bucket, encrypted" sh -c "ls '$T'/bucket/bk/test/wal/*.age >/dev/null && ! ls '$T'/bucket/bk/test/wal | grep -v '\.age\$'"
check "a second pass ships nothing again" sh -c "backup-wal-ship | { ! grep -q 'wal shipped'; }"

# The defaults (no key, no PITR) still write plain, checksummed dumps.
sleep 1
BACKUP_ENCRYPTION_KEY='' BACKUP_PITR=off backup >"$T/plain.log" 2>&1 || { cat "$T/plain.log" >&2; bad "plain backup runs"; }
plain=$(ls -t "$T"/backups/db-*.dump | head -n 1)
check "without a key the dump is plain and valid" sh -c "pg_restore --list '$plain' >/dev/null && test -s '$plain.sha256'"

# Point-in-time restore from the bucket's copy: A and B, not C.
pg_ctl -D "$T/pgdata" -m fast -w stop >/dev/null
restore-pitr "$(ls "$T"/backups/base-*.tar.gz.age | head -n 1)" --pgdata "$T/restored" \
  --target-time "$target" --offsite --wal-dir "$T/rwal" >"$T/pitr.log" 2>&1 || { cat "$T/pitr.log" >&2; bad "restore-pitr runs"; }
pg_ctl -D "$T/restored" -w -l "$T/restored.log" -o "-c archive_mode=off" start >/dev/null || { cat "$T/restored.log" >&2; bad "the restored server starts"; }
# Recovery ends with a promotion, a moment after the server accepts connections.
n=0
while [ "$(q 'select pg_is_in_recovery()' || echo t)" = t ] && [ "$n" -lt 60 ]; do
  n=$((n + 1))
  sleep 0.5
done
rows=$(q "select string_agg(v, ',' order by v) from t" || true)
if [ "$rows" = "A,B" ]; then ok "recovered to the target time: A,B"; else bad "recovered rows: '$rows', expected A,B"; fi
if q "insert into t values ('D')" >/dev/null; then ok "the recovered server accepts writes"; else bad "the recovered server accepts writes"; fi

# The encrypted dump: restore it into a second database.
PGDATABASE=restore_check restore "$(ls "$T"/backups/db-*.dump.age | head -n 1)" --yes >"$T/restore.log" 2>&1 || { cat "$T/restore.log" >&2; bad "restore of the encrypted dump runs"; }
rows=$(psql --no-psqlrc -At -d restore_check -c "select string_agg(v, ',' order by v) from t" || true)
if [ "$rows" = "A" ]; then ok "the encrypted dump restores (A)"; else bad "dump rows: '$rows', expected A"; fi
check "no decrypted copy is left behind" sh -c "! ls -A '$T'/backups | grep -q '^\.restore\.'"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
