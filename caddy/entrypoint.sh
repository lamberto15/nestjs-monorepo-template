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

# /.well-known/security.txt (RFC 9116), served by the Caddyfile from
# /srv/security. Caddy can't branch on an environment variable, so the file is
# written here, at each start: no file without SECURITY_CONTACT (the path is a
# 404). SECURITY_CONTACT: one or more URIs (mailto: or https:), comma-separated;
# the RFC requires Contact. SECURITY_EXPIRES: RFC 3339 in UTC; unset, a year
# from this start (so it renews at each start; pin it to keep one date).
# Policy and Preferred-Languages come from compose.prod.yaml's values.
security_file=/srv/security/.well-known/security.txt
rm -f "$security_file"
if [ -n "${SECURITY_CONTACT:-}" ]; then
  set -f # the values are split on commas and spaces below, never globbed
  contacts=$(printf '%s' "$SECURITY_CONTACT" | tr ',' ' ')
  for contact in $contacts; do
    case $contact in
      mailto:?*@?* | https://?*) ;;
      *) echo "SECURITY_CONTACT: $contact is not a mailto: or https: URI" >&2; exit 1 ;;
    esac
  done
  expires=${SECURITY_EXPIRES:-}
  if [ -z "$expires" ]; then
    # The same month and day a year on; 29 February becomes 1 March.
    md=$(date -u +%m-%d)
    if [ "$md" = 02-29 ]; then md=03-01; fi
    expires="$(( $(date -u +%Y) + 1 ))-$md"T$(date -u +%H:%M:%S)Z
  fi
  case $expires in
    ????-??-??T??:??:??Z) ;;
    *) echo "SECURITY_EXPIRES: $expires is not an RFC 3339 UTC time (2027-10-21T00:00:00Z)" >&2; exit 1 ;;
  esac
  mkdir -p /srv/security/.well-known
  {
    for contact in $contacts; do printf 'Contact: %s\n' "$contact"; done
    printf 'Expires: %s\n' "$expires"
    if [ -n "${SECURITY_POLICY:-}" ]; then printf 'Policy: %s\n' "$SECURITY_POLICY"; fi
    if [ -n "${SECURITY_PREFERRED_LANGUAGES:-}" ]; then
      printf 'Preferred-Languages: %s\n' "$SECURITY_PREFERRED_LANGUAGES"
    fi
  } > "$security_file"
  set +f
fi
exec "$@"
