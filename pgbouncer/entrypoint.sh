#!/bin/sh
# PgBouncer's entrypoint (compose.pgbouncer.yaml; docs/deployment.md,
# "PgBouncer"): writes its configuration and the users' list from the
# environment, then runs it. Written here rather than through the image's own
# env-var entrypoint: that one has no way to give each role its own pool size
# or to set track_extra_parameters, and the files below are short enough to
# read. Nothing is kept: the files live in the container's /tmp and are made
# again at every start, so the passwords never reach an image or a volume.
set -eu
umask 077

app_user=${POSTGRES_APP_USER:-app_runtime}
maintenance_user=${POSTGRES_MAINTENANCE_USER:-app_maintenance}

# Whole numbers only: a typo stops the start instead of reaching the file.
number() {
  case $2 in
    '' | *[!0-9]*)
      echo "pgbouncer: $1 must be a whole number, got \"$2\"" >&2
      exit 2
      ;;
  esac
}
number PGBOUNCER_POOL_SIZE "${PGBOUNCER_POOL_SIZE:-20}"
number PGBOUNCER_MAINTENANCE_POOL_SIZE "${PGBOUNCER_MAINTENANCE_POOL_SIZE:-3}"
number PGBOUNCER_MAX_CLIENT_CONN "${PGBOUNCER_MAX_CLIENT_CONN:-400}"
number PGBOUNCER_QUERY_WAIT_TIMEOUT "${PGBOUNCER_QUERY_WAIT_TIMEOUT:-10}"
number PGBOUNCER_DB_PORT "${PGBOUNCER_DB_PORT:-5432}"

if [ -z "${POSTGRES_APP_PASSWORD:-}" ]; then
  echo "pgbouncer: POSTGRES_APP_PASSWORD is not set (the app role's password: PgBouncer logs in to PostgreSQL as that role)" >&2
  exit 2
fi

dir=/tmp/pgbouncer
mkdir -p "$dir"

# "user" "password", a double quote doubled. Plain-text passwords are what
# auth_type scram-sha-256 needs to answer the client's SCRAM exchange and to
# log in to PostgreSQL with the same secret.
entry() {
  escaped=$(printf '%s' "$2" | sed 's/"/""/g')
  printf '"%s" "%s"\n' "$1" "$escaped"
}
{
  entry "$app_user" "$POSTGRES_APP_PASSWORD"
  if [ -n "${POSTGRES_MAINTENANCE_PASSWORD:-}" ]; then
    entry "$maintenance_user" "$POSTGRES_MAINTENANCE_PASSWORD"
  fi
} > "$dir/userlist.txt"

{
  echo '[databases]'
  echo "* = host=${PGBOUNCER_DB_HOST:-postgres} port=${PGBOUNCER_DB_PORT:-5432}"
  echo
  # One pool per user and database: the maintenance role's sweeps need a few.
  echo '[users]'
  echo "$app_user = pool_size=${PGBOUNCER_POOL_SIZE:-20}"
  if [ -n "${POSTGRES_MAINTENANCE_PASSWORD:-}" ]; then
    echo "$maintenance_user = pool_size=${PGBOUNCER_MAINTENANCE_POOL_SIZE:-3}"
  fi
  echo
  echo '[pgbouncer]'
  echo 'listen_addr = 0.0.0.0'
  echo 'listen_port = 5432'
  # No unix socket: the containers reach it over the network.
  echo 'unix_socket_dir ='
  echo 'auth_type = scram-sha-256'
  echo "auth_file = $dir/userlist.txt"
  # A server connection goes back to the pool at COMMIT or ROLLBACK. The app
  # keeps nothing in the session (docs/deployment.md, "PgBouncer").
  echo 'pool_mode = transaction'
  echo "max_client_conn = ${PGBOUNCER_MAX_CLIENT_CONN:-400}"
  # A client waits at most this long for a server connection, then gets an
  # error (the default, 120 s, would outlast every timeout the app has).
  echo "query_wait_timeout = ${PGBOUNCER_QUERY_WAIT_TIMEOUT:-10}"
  # node-postgres sends these two as startup parameters (the app's
  # DATABASE_STATEMENT_TIMEOUT_MS and DATABASE_IDLE_TX_TIMEOUT_MS): PgBouncer
  # refuses an unknown startup parameter, and ignore_startup_parameters would
  # drop them silently. Tracked, PgBouncer sets them on whichever server
  # connection serves the client, so the limits keep working.
  echo 'track_extra_parameters = statement_timeout, idle_in_transaction_session_timeout'
  # Protocol-level named statements are rewritten per server connection
  # (PgBouncer 1.21+); the app sends none by name, this only covers a driver
  # that does. SQL-level PREPARE is not supported in this mode.
  echo 'max_prepared_statements = 200'
  echo 'log_connections = 0'
  echo 'log_disconnections = 0'
  # No console users: nothing here needs the admin database.
  echo 'admin_users ='
  echo 'stats_users ='
} > "$dir/pgbouncer.ini"

exec /usr/bin/pgbouncer "$dir/pgbouncer.ini"
