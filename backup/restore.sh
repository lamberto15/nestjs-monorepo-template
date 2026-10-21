#!/bin/sh
# Restores one backup (docs/deployment.md, "Backups and restore"):
#
#   restore db-<time>.dump [--yes]        the database PGDATABASE
#   restore files-<time>.tar.gz [--yes]   the uploaded files, into BACKUP_STORAGE_DIR
#
# A name without a path is looked up in /backups. An encrypted backup (a
# .age suffix: db-<time>.dump.age) needs the age identity, BACKUP_DECRYPTION_KEY
# or BACKUP_DECRYPTION_KEY_FILE (docs/deployment.md, "Encryption"). The
# checksum is checked first. The database is loaded into a new database, and only once that
# worked are the two swapped: the previous one stays, renamed
# <name>_before_restore_<time>, until you drop it. Files are extracted over
# what the volume holds (nothing is deleted).
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh

STORAGE_DIR=${BACKUP_STORAGE_DIR:-/storage}

# Any failure ends with one JSON error line (3: stopped at the prompt).
on_exit() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then log error "restore failed" file="${name:-}" exit_code="$code"; fi
  # The decrypted copy and a temporary identity never stay behind.
  if [ -n "${plain_dir:-}" ]; then rm -f "$plain_dir"/* && rmdir "$plain_dir"; fi
  if [ -n "${IDENTITY_TMP:-}" ]; then rm -f "$IDENTITY_TMP"; fi
}
trap on_exit EXIT

usage() {
  echo "usage: restore db-<time>.dump | files-<time>.tar.gz [--yes]" >&2
  exit 2
}
[ $# -ge 1 ] || usage
file=$1
yes=${2:-}
case $file in /*) ;; *) file="$BACKUP_DIR/$file" ;; esac
name=$(basename "$file")
dir=$(dirname "$file")
if [ ! -f "$file" ]; then
  echo "No such backup: $file (docker compose exec backup ls -l /backups)" >&2
  exit 1
fi

if [ -f "$file.sha256" ]; then
  if ! (cd "$dir" && sha256sum -c -s "$name.sha256"); then
    echo "Checksum mismatch: $file is damaged" >&2
    exit 1
  fi
else
  log warn "no checksum file next to the backup: not verified" file="$file"
fi

# An encrypted backup is decrypted (checksum first, above) into a private
# directory of the backups volume, and restored from there.
case $name in
  *.age)
    age_identity
    plain_dir=$(umask 077 && mktemp -d "$BACKUP_DIR/.restore.XXXXXX")
    name=${name%.age}
    if ! age --decrypt --identity "$IDENTITY" --output "$plain_dir/$name" "$file"; then
      echo "Can't decrypt $file with the given identity" >&2
      exit 1
    fi
    file="$plain_dir/$name"
    ;;
esac

confirm() {
  [ "$yes" = --yes ] && return 0
  printf '%s\nType "%s" to continue: ' "$1" "$2"
  read -r answer
  if [ "$answer" != "$2" ]; then
    echo "Stopped: nothing changed."
    exit 3
  fi
}

started=$(date -u +%s)
case $name in
  db-*.dump)
    db=${PGDATABASE:?PGDATABASE is not set}
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    staging="${db}_restore"
    previous="${db}_before_restore_$stamp"
    toc=$(pg_restore --list "$file")
    objects=$(printf '%s\n' "$toc" | grep -vc '^;' || true)
    current=$(psql --no-psqlrc -At -v ON_ERROR_STOP=1 -v db="$db" --dbname=postgres <<'SQL'
SELECT count(*) FROM pg_database WHERE datname = :'db';
SQL
)
    if [ "$current" = 1 ]; then
      confirm "This replaces database \"$db\" on ${PGHOST:-localhost} with $name ($objects objects); the current one is kept as \"$previous\". Stop api and worker first." "$db"
    else
      previous=''
      confirm "This creates database \"$db\" on ${PGHOST:-localhost} from $name ($objects objects)." "$db"
    fi

    log info "restore started" file="$name" database="$db" objects="$objects"
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -v staging="$staging" --dbname=postgres <<'SQL'
SET client_min_messages = warning;
DROP DATABASE IF EXISTS :"staging";
CREATE DATABASE :"staging";
SQL
    # --no-owner: the objects belong to PGUSER (the owner), whoever owned them
    # before. --no-privileges: the dump's GRANTs and ALTER DEFAULT PRIVILEGES
    # name the app role (docs/deployment.md, "Database roles"), which a new
    # cluster doesn't have yet; `migrate` grants it everything again on the
    # next `docker compose up -d`, so nothing is lost by skipping them.
    if ! pg_restore --dbname="$staging" --no-owner --no-privileges --exit-on-error "$file"; then
      echo "Not restored: the database \"$db\" was not changed (\"$staging\" holds the partial load)." >&2
      exit 1
    fi

    # The swap: no session may be connected to either database.
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -v db="$db" -v staging="$staging" -v previous="$previous" \
      --dbname=postgres <<'SQL'
SELECT count(pg_terminate_backend(pid)) AS ended_sessions
  FROM pg_stat_activity WHERE datname IN (:'db', :'staging') AND pid <> pg_backend_pid() \gset
SELECT EXISTS (SELECT FROM pg_database WHERE datname = :'db') AS has_current \gset
\if :has_current
ALTER DATABASE :"db" RENAME TO :"previous";
\endif
ALTER DATABASE :"staging" RENAME TO :"db";
SQL
    if [ -n "$previous" ]; then
      log info "restore done: start api and worker; drop the previous database once all is well" \
        file="$name" database="$db" previous="$previous" objects="$objects" seconds=$(($(date -u +%s) - started))
    else
      log info "restore done" file="$name" database="$db" objects="$objects" seconds=$(($(date -u +%s) - started))
    fi
    ;;
  files-*.tar.gz)
    # The service mounts the volume read only: a restore mounts it again, writable.
    if ! touch "$STORAGE_DIR/.restore-check" 2>&1; then
      echo "$STORAGE_DIR is read only here: mount the volume writable (docs/deployment.md, Restoring)." >&2
      exit 1
    fi
    rm -f "$STORAGE_DIR/.restore-check"
    confirm "This extracts $name into $STORAGE_DIR, over the files there." "files"
    log info "restore started" file="$name" path="$STORAGE_DIR"
    # As root, owners are kept (the app's uid), so the app can write there again.
    tar -xzf "$file" -C "$STORAGE_DIR" --numeric-owner
    log info "restore done" file="$name" path="$STORAGE_DIR" seconds=$(($(date -u +%s) - started))
    ;;
  *)
    usage
    ;;
esac
