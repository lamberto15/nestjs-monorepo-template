#!/usr/bin/env bash
# The load test (docs/development.md, "Load tests"): starts the production
# stack under its own Compose project (compose.loadtest.yaml on top), runs the
# k6 scenarios inside its network, writes the baseline, and removes the stack
# and its volumes.
#
#   loadtest/run.sh            up, run, down (the default)
#   loadtest/run.sh up         start the stack (and keep it)
#   loadtest/run.sh run        run k6 against a started stack
#   loadtest/run.sh down       remove the stack and its volumes
#   loadtest/run.sh config     the stack's Compose configuration (a check)
#
# LOADTEST_PROJECT  Compose project, loadtest-<name> only (loadtest-local):
#                   `down` removes its volumes, so it can never name a deployment
# LOADTEST_OUT      where the baseline and the stack's env file go (loadtest/results)
# APP_IMAGE         an image already built (CI); unset, the stack builds one
# PHASE_SECONDS, SIGN_IN_RATE, LIST_RATE, CREATE_RATE: scenarios.js' load
#
# Its own env file: the repository's .env (a deployment's) is never read.
set -euo pipefail

cd "$(dirname "$0")/.."

# k6's release (github.com/grafana/k6), tag and digest: Dependabot doesn't raise it.
export K6_IMAGE=grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34

project=${LOADTEST_PROJECT:-loadtest-local}
# An allowlist, not a list of known deployments: a project made from this
# template has its own name, and `down --volumes` must never reach it.
if ! [[ "$project" =~ ^loadtest-[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "LOADTEST_PROJECT=$project: the load test's projects are named loadtest-<name> (lowercase)" >&2
  exit 2
fi
out=${LOADTEST_OUT:-loadtest/results}
mkdir -p "$out"
out=$(cd "$out" && pwd)
env_file="$out/stack.env"

# The stack's settings, made once per output directory (a started stack
# keeps its generated secrets). PASSWORD_BREACH_CHECK=off: the seeded users'
# password isn't sent to Pwned Passwords. LOADTEST_USER_PASSWORD: the seeded
# users' password, generated like the rest (k6 refuses to seed without it).
if [ ! -f "$env_file" ]; then
  (
    umask 077
    {
      echo APP_DOMAIN=loadtest.invalid
      echo ACME_EMAIL=loadtest@example.com
      echo CLOUDFLARE_API_TOKEN=unused
      echo ADMIN_EMAIL=load-test-admin@example.com
      echo PASSWORD_BREACH_CHECK=off
      echo "APP_IMAGE=${APP_IMAGE:-}"
      for name in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_MAINTENANCE_PASSWORD REDIS_PASSWORD ADMIN_PASSWORD LOADTEST_USER_PASSWORD; do
        echo "$name=$(openssl rand -hex 24)"
      done
    } > "$env_file"
  )
fi

# The files named here, never an exported COMPOSE_FILE (it would drop the
# overlay: Caddy publishing 80 and 443, the limits not raised).
compose() {
  env -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME docker compose \
    --project-name "$project" --env-file "$env_file" \
    -f compose.yaml -f compose.prod.yaml -f compose.loadtest.yaml "$@"
}
setting() { grep -E "^$1=" "$env_file" | cut -d= -f2-; }

up() {
  if [ -n "$(setting APP_IMAGE)" ]; then
    compose up -d --no-build --remove-orphans
  else
    compose up -d --build --remove-orphans
  fi
  echo "Waiting for the API behind Caddy..."
  for _ in $(seq 1 90); do
    if compose exec -T caddy wget -q --spider http://127.0.0.1/health 2> /dev/null; then
      compose ps
      return 0
    fi
    sleep 2
  done
  compose ps -a
  compose logs --tail 50 migrate api
  echo "The stack didn't become healthy." >&2
  return 1
}

run() {
  # The administrator's credentials reach k6 through its environment, never
  # on a command line.
  ADMIN_EMAIL=$(setting ADMIN_EMAIL) ADMIN_PASSWORD=$(setting ADMIN_PASSWORD) \
    LOADTEST_USER_PASSWORD=$(setting LOADTEST_USER_PASSWORD) \
    GIT_SHA=${GIT_SHA:-$(git rev-parse HEAD 2> /dev/null || true)} \
    docker run --rm \
    --network "${project}_default" \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/loadtest:/scripts:ro" \
    -v "$out:/out" \
    -e BASE_URL=http://caddy \
    -e BASELINE_FILE=/out/baseline.json \
    -e K6_NO_USAGE_REPORT=true \
    -e ADMIN_EMAIL -e ADMIN_PASSWORD -e LOADTEST_USER_PASSWORD -e GIT_SHA -e K6_IMAGE \
    -e PHASE_SECONDS -e SIGN_IN_RATE -e LIST_RATE -e CREATE_RATE \
    "$K6_IMAGE" run --quiet /scripts/scenarios.js
}

down() {
  compose --profile backup down --volumes --remove-orphans
  rm -f "$env_file"
}

case "${1:-all}" in
  up) up ;;
  run) run ;;
  down) down ;;
  config) compose config ;;
  all)
    trap down EXIT
    up
    run
    ;;
  *)
    echo "usage: $0 [up|run|down|config|all]" >&2
    exit 2
    ;;
esac
