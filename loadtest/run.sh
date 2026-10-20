#!/usr/bin/env bash
# The load test (docs/development.md, "Load tests"): starts the production
# stack under its own Compose project (compose.loadtest.yaml on top), runs the
# k6 scenarios inside its network, writes the baseline, and removes the stack
# and its volumes.
#
#   loadtest/run.sh            up, run, down (the default)
#   loadtest/run.sh up         start the stack (and keep it)
#   loadtest/run.sh run        run k6 against a started stack
#   loadtest/run.sh realtime   run the Artillery socket.io scenario against it
#   loadtest/run.sh down       remove the stack and its volumes
#   loadtest/run.sh config     the stack's Compose configuration (a check)
#
# LOADTEST_PROJECT  Compose project, loadtest-<name> only (loadtest-local):
#                   `down` removes its volumes, so it can never name a deployment
# LOADTEST_OUT      where the baseline and the stack's env file go (loadtest/results)
# APP_IMAGE         an image already built (CI); unset, the stack builds one
# LOADTEST_REPLICAS API replicas behind Caddy, 1 to 6 (default 2: compose.prod.yaml's)
# LOADTEST_CAPTCHA  `always` puts the bot check in place with the stub provider
#                   (compose.loadtest.yaml); default off. k6 then sends a token
# LOADTEST_REALTIME `off` leaves the Artillery socket.io run out of the default run
# PHASE_SECONDS, SIGN_IN_RATE, LIST_RATE, CREATE_RATE, EXPORT_RATE: scenarios.js' load
# REALTIME_RATE     new socket.io connections a second (realtime.yml, default 10)
#
# Its own env file: the repository's .env (a deployment's) is never read.
set -euo pipefail

cd "$(dirname "$0")/.."

# k6's release (github.com/grafana/k6), tag and digest: Dependabot doesn't raise it.
export K6_IMAGE=grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34

# Artillery's release (github.com/artilleryio/artillery), tag and digest. It
# speaks socket.io, which k6 doesn't (docs/roadmap.md, item 17).
export ARTILLERY_IMAGE=artilleryio/artillery:2.0.34@sha256:0d927c76853314d94c6545515821ac98971443301820b93d5193fe2be85780a2

replicas=${LOADTEST_REPLICAS:-2}
# Up to 6: each replica holds DATABASE_POOL_MAX (10) connections of the
# PostgreSQL's 100.
if ! [[ "$replicas" =~ ^[1-6]$ ]]; then
  echo "LOADTEST_REPLICAS=$replicas: 1 to 6 api replicas" >&2
  exit 2
fi
captcha=${LOADTEST_CAPTCHA:-off}
if [ "$captcha" != off ] && [ "$captcha" != always ]; then
  echo "LOADTEST_CAPTCHA=$captcha: off or always" >&2
  exit 2
fi

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
# keeps its generated secrets). PASSWORD_BREACH_CHECK=off: the seeded
# administrator's password isn't sent to Pwned Passwords.
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
      for name in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_MAINTENANCE_PASSWORD REDIS_PASSWORD ADMIN_PASSWORD; do
        echo "$name=$(openssl rand -hex 24)"
      done
      # The encrypted columns' key (docs/encryption.md), required at boot.
      echo "DATA_ENCRYPTION_KEYS=$(openssl rand -base64 32)"
      echo "BLIND_INDEX_KEYS=$(openssl rand -base64 32)"
    } > "$env_file"
  )
fi

# The files named here, never an exported COMPOSE_FILE (it would drop the
# overlay: Caddy publishing 80 and 443, the limits not raised).
compose() {
  env -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME \
    API_REPLICAS="$replicas" LOADTEST_CAPTCHA="$captcha" docker compose \
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
    GIT_SHA=${GIT_SHA:-$(git rev-parse HEAD 2> /dev/null || true)} \
    docker run --rm \
    --network "${project}_default" \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/loadtest:/scripts:ro" \
    -v "$out:/out" \
    -e BASE_URL=http://caddy \
    -e BASELINE_FILE=/out/baseline.json \
    -e K6_NO_USAGE_REPORT=true \
    -e ADMIN_EMAIL -e ADMIN_PASSWORD -e GIT_SHA -e K6_IMAGE \
    -e PHASE_SECONDS -e SIGN_IN_RATE -e LIST_RATE -e CREATE_RATE -e EXPORT_RATE \
    -e REPLICAS="$replicas" -e CAPTCHA="$captcha" \
    "$K6_IMAGE" run --quiet /scripts/scenarios.js
}

# Realtime: socket.io through Artillery (k6 doesn't speak it), at the /realtime
# namespace behind Caddy. Its thresholds (loadtest/realtime.yml, "ensure") fail
# the run; the report goes to the output directory.
realtime() {
  local rate=${REALTIME_RATE:-10} seconds=${PHASE_SECONDS:-60}
  [[ "$rate" =~ ^[1-9][0-9]*$ && "$seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo "REALTIME_RATE and PHASE_SECONDS are whole numbers" >&2
    exit 2
  }
  # Run as the caller (the report lands owned by them), whom the image's
  # /etc/passwd doesn't know: Node's os.userInfo() (Artillery calls it) fails
  # with ENOENT, so the host's passwd file is mounted read-only.
  ADMIN_EMAIL=$(setting ADMIN_EMAIL) ADMIN_PASSWORD=$(setting ADMIN_PASSWORD) \
    docker run --rm \
    --network "${project}_default" \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/loadtest:/scripts:ro" \
    -v "$out:/out" \
    -v /etc/passwd:/etc/passwd:ro \
    -e HOME=/tmp \
    -e ARTILLERY_DISABLE_TELEMETRY=true \
    -e BASE_URL=http://caddy \
    -e CAPTCHA="$captcha" \
    -e ADMIN_EMAIL -e ADMIN_PASSWORD \
    "$ARTILLERY_IMAGE" run \
    --overrides "{\"config\":{\"phases\":[{\"duration\":$seconds,\"arrivalRate\":$rate}]}}" \
    --output /out/realtime.json /scripts/realtime.yml
}

down() {
  compose --profile backup down --volumes --remove-orphans
  rm -f "$env_file"
}

case "${1:-all}" in
  up) up ;;
  run) run ;;
  realtime) realtime ;;
  down) down ;;
  config) compose config ;;
  all)
    trap down EXIT
    up
    run
    if [ "${LOADTEST_REALTIME:-on}" != off ]; then realtime; fi
    ;;
  *)
    echo "usage: $0 [up|run|realtime|down|config|all]" >&2
    exit 2
    ;;
esac
