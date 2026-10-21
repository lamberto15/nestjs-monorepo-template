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

# connect-src of the web app's Content-Security-Policy (caddy/Caddyfile reads
# $WEB_CONNECT_SRC): this origin, and with STORAGE_DRIVER=s3 the bucket's, since
# the browser PUTs a direct upload straight to it (docs/attachments.md, "Direct
# uploads"); the policy would block that request before any CORS check. The
# origin is the one the API's S3 disk signs its URLs for (@nestjs/storage's
# S3Disk): S3_ENDPOINT, or https://s3.<S3_REGION or AWS_REGION>.amazonaws.com,
# with the bucket in front of the host (virtual-hosted style), or without it
# (path style: S3_FORCE_PATH_STYLE=on, an IP address as the host, or a bucket
# name that is not a DNS label). Anything that does not parse is left out, with
# a warning: the web app then uploads through the API (docs/attachments.md).
WEB_CONNECT_SRC="'self'"
if [ "${STORAGE_DRIVER:-}" = s3 ] && [ -n "${S3_BUCKET:-}" ]; then
  bucket=$S3_BUCKET
  endpoint=${S3_ENDPOINT:-}
  region=${S3_REGION:-${AWS_REGION:-}}
  if [ -z "$endpoint" ] && [ -n "$region" ]; then
    endpoint=https://s3.$region.amazonaws.com
  fi
  scheme=${endpoint%%://*}
  host=${endpoint#*://}
  host=${host%%/*}
  case $scheme in http | https) ;; *) host= ;; esac
  # Only what a host and a bucket name are made of: nothing that could end the directive.
  case $host$bucket in
    *[!]A-Za-z0-9._:[-]*) host= ;;
  esac
  if [ -z "$host" ]; then
    echo 'STORAGE_DRIVER=s3: no bucket origin from S3_ENDPOINT, S3_REGION and S3_BUCKET; the web app'"'"'s Content-Security-Policy leaves it out' >&2
  else
    path_style=no
    if [ "${S3_FORCE_PATH_STYLE:-}" = on ]; then path_style=yes; fi
    case $host in
      \[*) path_style=yes ;; # an IPv6 address
      *[!0-9.:]*) ;;          # a name
      *.*.*.*) path_style=yes ;; # an IPv4 address (and a port)
    esac
    case $bucket in
      -* | *- | .* | *. | *..*) path_style=yes ;;
    esac
    if [ ${#bucket} -lt 3 ] || [ ${#bucket} -gt 63 ]; then path_style=yes; fi
    if [ "$scheme" = http ]; then
      case $bucket in *[!a-z0-9.-]*) path_style=yes ;; esac
    else
      case $bucket in *[!a-z0-9-]*) path_style=yes ;; esac
    fi
    if [ "$path_style" = yes ]; then
      WEB_CONNECT_SRC="'self' $scheme://$host"
    else
      WEB_CONNECT_SRC="'self' $scheme://$bucket.$host"
    fi
  fi
fi
export WEB_CONNECT_SRC
exec "$@"
