#!/bin/sh
# The devcontainer's smoke test (.github/workflows/devcontainer.yml; docs/development.md,
# "Devcontainer"). Run inside the workspace, from /workspace, once
# post-create.sh has run:
#
#   devcontainer exec --workspace-folder . sh .devcontainer/smoke-test.sh
#
# Starts `pnpm dev` (the API and the web app), waits for the web app to
# answer, then checks what the editor's port forward relies on: Vite on
# 127.0.0.1 and on ::1 (WEB_DEV_HOST=::), and the API through Vite's proxy
# (/health). Any answer outside 2xx fails the test, and the dev server's log
# is printed. SMOKE_TIMEOUT: seconds to wait (default 300; the first start
# builds the API and the typed client).
set -eu

timeout="${SMOKE_TIMEOUT:-300}"
log="${TMPDIR:-/tmp}/devcontainer-smoke-dev.log"
urls='http://127.0.0.1:5173/
http://[::1]:5173/
http://127.0.0.1:5173/health'

# The status of one URL, 000 when nothing answers. -g: the brackets of an
# IPv6 address are not a glob. No redirects followed: a 3xx is not a 2xx.
status() {
  curl -g -s -o "${TMPDIR:-/tmp}/devcontainer-smoke-body" -w '%{http_code}' --max-time 5 "$1" || true
}

# True when every URL answers 2xx.
all_ready() {
  for url in $urls; do
    case "$(status "$url")" in
      2??) ;;
      *) return 1 ;;
    esac
  done
}

fail() {
  echo "::error::$1"
  echo "----- pnpm dev log ($log) -----"
  cat "$log"
  exit 1
}

# Its own session and no stdin: `devcontainer exec` returns when this script
# does, and takes the dev server down with the container.
setsid nohup pnpm dev >"$log" 2>&1 <&- &
dev_pid=$!

echo "Waiting up to ${timeout}s for the web app and the API behind it."
elapsed=0
until all_ready; do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    fail 'pnpm dev exited before the web app answered'
  fi
  if [ "$elapsed" -ge "$timeout" ]; then
    fail "no answer from the web app and the API within ${timeout}s"
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
echo "Ready after about ${elapsed}s."

# One more round, each URL on its own line, for the log; any failure is final.
failed=0
for url in $urls; do
  code="$(status "$url")"
  echo "$code $url"
  case "$code" in
    2??) ;;
    *) failed=1 ;;
  esac
done
if [ "$failed" -ne 0 ]; then
  fail 'a URL did not answer 2xx'
fi
echo 'Smoke test passed.'
