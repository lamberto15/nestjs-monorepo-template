#!/usr/bin/env bash
# The shell readers of the secrets' files (docs/deployment.md, "Secrets in
# files"), each in the image it runs in: redis/redis.sh (Redis, its
# healthcheck), caddy/entrypoint.sh, backup/lib.sh and Alertmanager's
# render-config.sh. Like the app: a trailing LF or CRLF dropped, both set or
# an empty file refused; and Redis' password never on a command line.
#
#   scripts/test-secret-readers.sh      (Docker; from anywhere)
# shellcheck disable=SC2016 # single-quoted: expanded inside the containers
set -euo pipefail
cd "$(dirname "$0")/.."

redis_image=$(grep -oE 'redis:[0-9][^[:space:]]*' compose.yaml | head -1)
caddy_image=$(grep -oE '^FROM caddy:[0-9][^[:space:]]*$' caddy/Dockerfile | cut -d' ' -f2)
postgres_image=$(grep -oE '^FROM postgres:[^[:space:]]+' backup/Dockerfile | cut -d' ' -f2)
alertmanager_image=$(grep -oE 'prom/alertmanager:v[0-9][^[:space:]]*' compose.monitoring.yaml)

dir=$(mktemp -d)
trap 'rm -r "$dir"' EXIT
chmod 755 "$dir"
secret=$(openssl rand -hex 16)
printf '%s\r\n' "$secret" > "$dir/crlf"
printf '%s\n' "$secret" > "$dir/lf"
: > "$dir/empty"
printf 'smtps://alerts%%40example.com:%s@mail.example.com:465\r\n' "$secret" > "$dir/smtp_url"
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
  if [ "$actual" = "$code" ]; then pass "$name"; else fail "$name: exit $actual, expected $code: $(cat "$dir/out")"; fi
}
# expect_output <name> <expected stdout> <docker run arguments…>
expect_output() {
  local name=$1 expected=$2 actual
  shift 2
  actual=$(docker run --rm "$@" 2> "$dir/err") || true
  if [ "$actual" = "$expected" ]; then pass "$name"; else fail "$name: got [$actual] $(cat "$dir/err")"; fi
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

# The backup's lib.sh (every backup script sources it).
backup=(-v "$PWD/backup/lib.sh:/lib.sh:ro" -v "$dir:/secrets:ro" --entrypoint sh)
expect_output "backup: PGPASSWORD from a CRLF file" "$secret" "${backup[@]}" \
  -e PGPASSWORD_FILE=/secrets/crlf "$postgres_image" -c '. /lib.sh; printf %s "$PGPASSWORD${PGPASSWORD_FILE:-}"'
expect_output "backup: the S3 key from a file" "$secret" "${backup[@]}" \
  -e BACKUP_S3_SECRET_ACCESS_KEY_FILE=/secrets/lf "$postgres_image" -c '. /lib.sh; printf %s "$BACKUP_S3_SECRET_ACCESS_KEY"'
expect_exit "backup refuses both set" 2 "${backup[@]}" -e PGPASSWORD=x \
  -e PGPASSWORD_FILE=/secrets/lf "$postgres_image" -c '. /lib.sh'
expect_exit "backup refuses an empty file" 2 "${backup[@]}" \
  -e PGPASSWORD_FILE=/secrets/empty "$postgres_image" -c '. /lib.sh'

# Alertmanager: the app's SMTP_URL from its file, as the mail default.
alertmanager=(-v "$PWD/monitoring/alertmanager:/etc/alertmanager/scripts:ro"
  -v "$PWD/monitoring/alertmanager/watchdog-url.empty:/run/secrets/alert_watchdog_url:ro"
  -v "$dir:/secrets:ro" -e ALERT_EMAIL_TO=ops@example.com -e MAIL_FROM=noreply@example.com
  --entrypoint sh)
expect_exit "alertmanager: SMTP_URL from a CRLF file, the configuration checks" 0 "${alertmanager[@]}" \
  -e SMTP_URL_FILE=/secrets/smtp_url "$alertmanager_image" -c \
  "/etc/alertmanager/scripts/render-config.sh --check && grep -q 'mail.example.com:465' /tmp/alertmanager.yml && grep -q '$secret.$' /tmp/alertmanager.yml"
expect_exit "alertmanager refuses SMTP_URL and SMTP_URL_FILE both set" 1 "${alertmanager[@]}" \
  -e SMTP_URL=smtps://x@mail.example.com -e SMTP_URL_FILE=/secrets/smtp_url "$alertmanager_image" \
  /etc/alertmanager/scripts/render-config.sh --check

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo 'all passed'
