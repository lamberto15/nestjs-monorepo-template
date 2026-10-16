#!/bin/sh
# The Cloudflare token for the DNS challenge: CLOUDFLARE_API_TOKEN, or the
# file CLOUDFLARE_API_TOKEN_FILE names (a Docker secret, compose.prod.yaml;
# trailing line breaks dropped, a CRLF too). Exactly one; then Caddy, as the
# image runs it.
set -eu
if [ -n "${CLOUDFLARE_API_TOKEN_FILE:-}" ]; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_FILE are both set: keep one' >&2
    exit 1
  fi
  cr=$(printf '\r')
  if ! CLOUDFLARE_API_TOKEN=$(cat "$CLOUDFLARE_API_TOKEN_FILE") ||
    ! CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN%"$cr"} ||
    [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "CLOUDFLARE_API_TOKEN_FILE: can't read $CLOUDFLARE_API_TOKEN_FILE, or it is empty" >&2
    exit 1
  fi
  export CLOUDFLARE_API_TOKEN
  unset CLOUDFLARE_API_TOKEN_FILE
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo 'Set CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_TOKEN_FILE) in .env' >&2
  exit 1
fi
exec "$@"
