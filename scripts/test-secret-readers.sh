#!/usr/bin/env bash
# The shell readers of the secrets' files (docs/deployment.md, "Secrets in
# files"), each in the image it runs in: redis/redis.sh (Redis, its
# healthcheck) and caddy/entrypoint.sh. Like the app: a trailing LF or CRLF dropped, both set or
# an empty file refused; and Redis' password never on a command line.
#
#   scripts/test-secret-readers.sh      (Docker; from anywhere)
# shellcheck disable=SC2016 # single-quoted: expanded inside the containers
set -euo pipefail
cd "$(dirname "$0")/.."

redis_image=$(grep -oE 'redis:[0-9][^[:space:]]*' compose.yaml | head -1)
caddy_image=$(grep -oE '^FROM caddy:[0-9][^[:space:]]*$' caddy/Dockerfile | cut -d' ' -f2)

dir=$(mktemp -d)
trap 'rm -r "$dir"' EXIT
chmod 755 "$dir"
secret=$(openssl rand -hex 16)
printf '%s\r\n' "$secret" > "$dir/crlf"
printf '%s\n' "$secret" > "$dir/lf"
: > "$dir/empty"
chmod 644 "$dir"/*

failures=0
pass() { echo "ok    $1"; }
fail() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}
# expect_exit <name> <code> <docker run arguments…>
expect_exit() {
  local name=$1 code=$2 actual=0
  shift 2
  docker run --rm "$@" > "$dir/out" 2>&1 || actual=$?
  if [[ "$actual" = "$code" ]]; then pass "$name"; else fail "$name: exit $actual, expected $code: $(cat "$dir/out")"; fi
}
# expect_output <name> <expected stdout> <docker run arguments…>
expect_output() {
  local name=$1 expected=$2 actual
  shift 2
  actual=$(docker run --rm "$@" 2> "$dir/err") || true
  if [[ "$actual" = "$expected" ]]; then pass "$name"; else fail "$name: got [$actual] $(cat "$dir/err")"; fi
}

# Redis: the server and the healthcheck in one container, then every
# process's command line.
redis_check() {
  docker run --rm -v "$PWD/redis:/s:ro" -v "$dir:/secrets:ro" "$@" --entrypoint sh "$redis_image" -c '
    sh /s/redis.sh server > /tmp/log 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do sh /s/redis.sh ping && break; sleep 0.5; done
    sh /s/redis.sh ping && echo ping-ok
    redis-cli ping
    for f in /proc/[0-9]*/cmdline; do tr "\0" " " < "$f"; echo; done > /tmp/args 2> /tmp/errors
    if grep -q "$SECRET" /tmp/args; then echo password-in-args; fi'
}
out=$(redis_check -e SECRET="$secret" -e REDIS_PASSWORD_FILE=/secrets/crlf)
case $out in
  *password-in-args*) fail "redis (file): the password is on a command line" ;;
  *ping-ok*NOAUTH*) pass "redis (file, CRLF): the password from the file, on no command line" ;;
  *) fail "redis (file): $out" ;;
esac
out=$(redis_check -e SECRET="$secret" -e REDIS_PASSWORD="$secret")
case $out in
  *password-in-args*) fail "redis (variable): the password is on a command line" ;;
  *ping-ok*NOAUTH*) pass "redis (variable): the password, on no command line" ;;
  *) fail "redis (variable): $out" ;;
esac
out=$(redis_check -e SECRET=none)
case $out in
  *ping-ok*PONG*) pass "redis (none): no password, as before" ;;
  *) fail "redis (none): $out" ;;
esac
for mode in server ping; do
  expect_exit "redis $mode refuses an empty file" 1 -v "$PWD/redis:/s:ro" -v "$dir:/secrets:ro" \
    -e REDIS_PASSWORD_FILE=/secrets/empty --entrypoint sh "$redis_image" /s/redis.sh "$mode"
  expect_exit "redis $mode refuses both set" 1 -v "$PWD/redis:/s:ro" -v "$dir:/secrets:ro" \
    -e REDIS_PASSWORD=x -e REDIS_PASSWORD_FILE=/secrets/lf --entrypoint sh "$redis_image" /s/redis.sh "$mode"
done

# Caddy's entrypoint: the token for the command it then runs.
caddy=(-v "$PWD/caddy/entrypoint.sh:/entrypoint.sh:ro" -v "$dir:/secrets:ro" --entrypoint sh)
show_token=(sh -c 'printf %s "$CLOUDFLARE_API_TOKEN${CLOUDFLARE_API_TOKEN_FILE:-}"')
expect_output "caddy: the token from a CRLF file" "$secret" "${caddy[@]}" \
  -e CLOUDFLARE_API_TOKEN_FILE=/secrets/crlf "$caddy_image" /entrypoint.sh "${show_token[@]}"
expect_output "caddy: the token from the variable" "$secret" "${caddy[@]}" \
  -e CLOUDFLARE_API_TOKEN="$secret" "$caddy_image" /entrypoint.sh "${show_token[@]}"
expect_exit "caddy refuses both set" 1 "${caddy[@]}" -e CLOUDFLARE_API_TOKEN=x \
  -e CLOUDFLARE_API_TOKEN_FILE=/secrets/lf "$caddy_image" /entrypoint.sh true
expect_exit "caddy refuses an empty file" 1 "${caddy[@]}" \
  -e CLOUDFLARE_API_TOKEN_FILE=/secrets/empty "$caddy_image" /entrypoint.sh true
expect_exit "caddy refuses no token" 1 "${caddy[@]}" "$caddy_image" /entrypoint.sh true

if [[ "$failures" -gt 0 ]]; then
  echo "$failures failed" >&2
  exit 1
fi
echo 'all passed'
