#!/bin/sh
# Redis' password for the server, its healthcheck and the exporter
# (compose.yaml, compose.monitoring.yaml): REDIS_PASSWORD, or the file
# REDIS_PASSWORD_FILE names (a Docker secret, compose.prod.yaml; one trailing
# CRLF or LF dropped), never both. Never on a command line, where ps and
# `docker top` show it: the server reads it from stdin, redis-cli from
# REDISCLI_AUTH, the exporter from REDIS_PASSWORD.
#
#   redis.sh server     redis-server (append-only, REDIS_MAXMEMORY, noeviction)
#   redis.sh ping       the healthcheck
#   redis.sh exporter   /redis_exporter
set -eu

fail() {
  echo "redis: $*" >&2
  exit 1
}

pass=${REDIS_PASSWORD:-}
file=${REDIS_PASSWORD_FILE:-}
if [ -n "$file" ]; then
  [ -z "$pass" ] || fail 'REDIS_PASSWORD and REDIS_PASSWORD_FILE are both set: keep one'
  pass=$(cat "$file") || fail "REDIS_PASSWORD_FILE: can't read $file"
  cr=$(printf '\r')
  pass=${pass%"$cr"}
  [ -n "$pass" ] || fail "REDIS_PASSWORD_FILE: $file is empty"
fi
unset REDIS_PASSWORD_FILE

case ${1:-server} in
  server)
    set -- --appendonly yes --maxmemory "${REDIS_MAXMEMORY:-400mb}" --maxmemory-policy noeviction
    if [ -z "$pass" ]; then exec redis-server "$@"; fi
    unset REDIS_PASSWORD
    # Redis' configuration syntax: inside double quotes, \ and " are escaped.
    escaped=$(printf '%s' "$pass" | sed 's/[\\"]/\\&/g')
    exec redis-server - "$@" <<CONFIG
requirepass "$escaped"
CONFIG
    ;;
  ping)
    if [ -n "$pass" ]; then export REDISCLI_AUTH="$pass"; fi
    redis-cli ping | grep -q PONG
    ;;
  exporter)
    export REDIS_PASSWORD="$pass"
    exec /redis_exporter
    ;;
  *) fail "unknown command: $1" ;;
esac
