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

# The origins the web app may reach for files: its Content-Security-Policy
# (caddy/Caddyfile) names WEB_FILES_ORIGINS, after 'self', in connect-src and
# img-src alike. With STORAGE_DRIVER=s3 the browser PUTs a direct upload to the
# bucket (docs/attachments.md, "Direct uploads") and an <img> follows an
# attachment's thumbnail to the bucket's signed link ("Image renditions"); a
# policy without that origin blocks both, before any CORS check. One list, each
# origin once, from two sources:
# - The bucket's origin, derived from the app's own S3 settings as the API's S3
#   disk (@nestjs/storage's S3Disk) signs its URLs: S3_ENDPOINT, or
#   https://s3.<S3_REGION or AWS_REGION>.amazonaws.com, with the bucket in
#   front of the host (virtual-hosted style), or else the host with the
#   bucket's path, <scheme>://<host>/<bucket>/ (path style: S3_FORCE_PATH_STYLE=on,
#   an IP address as the host, or a bucket name that is not a DNS label). Never
#   the bare host: on AWS and other shared stores it serves every customer's
#   buckets. The PUT goes to /<bucket>/<key>, which the path matches, and CSP
#   ignores a source's path after a redirect, so the thumbnail's 302 to the
#   signed link still loads. Settings it can't make an origin of leave it out,
#   with a warning: uploads then go through the API, thumbnails show the file icon.
# - FILES_ORIGIN, the operator's: what the settings can't tell (a custom domain
#   or a CDN in front of the bucket). Space-separated https origins
#   (https://host[:port]), nothing else: it goes into the policy as written, and
#   a path, a quote, a semicolon or a wildcard would add a directive or widen
#   the policy, so such a value stops the start.
# WEB_FILES_ORIGINS is always this list: a value from the environment is replaced.
WEB_FILES_ORIGINS=
set -f # the lists are split on spaces below, never globbed
for origin in ${FILES_ORIGIN:-}; do
  host=
  case $origin in https://*) host=${origin#https://} ;; esac
  case $host in
    '' | *[!A-Za-z0-9.:-]*)
      echo "FILES_ORIGIN: $origin is not an https origin (https://host[:port], no path)" >&2
      exit 1
      ;;
  esac
done
bucket_origin=
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
  # Only what a host and a bucket name are made of: nothing that could end the
  # directive. The bucket, which can become a source's path, gets the narrower
  # set Helm's helper uses too.
  case $host in
    *[!]A-Za-z0-9._:[-]*) host= ;;
  esac
  case $bucket in
    *[!A-Za-z0-9._-]*) host= ;;
  esac
  if [ -z "$host" ]; then
    echo 'STORAGE_DRIVER=s3: no bucket origin from S3_ENDPOINT, S3_REGION and S3_BUCKET; the web app'"'"'s Content-Security-Policy leaves it out (FILES_ORIGIN can name it)' >&2
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
      bucket_origin=$scheme://$host/$bucket/
    else
      bucket_origin=$scheme://$bucket.$host
    fi
  fi
fi
for origin in $bucket_origin ${FILES_ORIGIN:-}; do
  case " $WEB_FILES_ORIGINS " in
    *" $origin "*) ;;
    *) WEB_FILES_ORIGINS=${WEB_FILES_ORIGINS:+$WEB_FILES_ORIGINS }$origin ;;
  esac
done
set +f
export WEB_FILES_ORIGINS

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
