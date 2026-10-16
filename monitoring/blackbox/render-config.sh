#!/bin/sh
# The blackbox exporter reads no environment variables, so this writes its
# module from them (compose.monitoring.yaml passes them from .env), then
# starts it with the arguments given.
#
#   PROBE_HOST  the public host name Caddy serves (default: APP_DOMAIN). The
#               probe connects to caddy:443 by its Compose name and sends this
#               name as the TLS server name (SNI) and the Host header: Caddy
#               picks the site and its certificate by them, and the
#               certificate is checked against it. Containers don't read the
#               host's /etc/hosts, and the name may have no public DNS record,
#               so the probe can't go by the name itself.
#
# Check the result without starting: render-config.sh --check.
set -eu

out=${BLACKBOX_CONFIG:-/tmp/blackbox.yml}
host=${PROBE_HOST:-}

# A host name only (no scheme, port or path): it goes into YAML unquoted.
case "$host" in
  '' | *[!A-Za-z0-9.-]*)
    echo "render-config: PROBE_HOST (or APP_DOMAIN) must be a host name such as api.example.com, not '$host'" >&2
    exit 1
    ;;
esac

umask 077
cat >"$out" <<EOF
# Written by render-config.sh at start: edit that script, not this file.
modules:
  # Prometheus' probe job: https://caddy:443/health/live as $host.
  https_caddy:
    prober: http
    timeout: 5s
    http:
      method: GET
      valid_status_codes: [200]
      # Docker's network: IPv4.
      preferred_ip_protocol: ip4
      ip_protocol_fallback: false
      fail_if_not_ssl: true
      # A redirect would hide what Caddy answers itself.
      follow_redirects: false
      headers:
        Host: $host
      tls_config:
        server_name: $host
      # The api's liveness answer, not some other 200 (Caddy answers 200
      # with an empty body for a host it doesn't serve).
      fail_if_body_not_matches_regexp:
        - '"status":"ok"'
EOF

if [ "${1:-}" = --check ]; then
  exec /bin/blackbox_exporter --config.file="$out" --config.check
fi
exec /bin/blackbox_exporter --config.file="$out" "$@"
