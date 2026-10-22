#!/usr/bin/env bash
# Exercise the built image with production's hardening, on disposable volumes.
# No real domain, Cloudflare token or ACME request: Caddy's local CA proves
# certificate persistence, permissions and HTTPS on the same low ports.
set -euo pipefail
image=${1:?usage: caddy/test-runtime.sh IMAGE}
prefix=caddy-runtime-$$-$RANDOM
dir=$(mktemp -d)
name=$prefix
volumes=("$prefix-data" "$prefix-config")
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  for volume in "${volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
  rm -rf "$dir"
}
trap cleanup EXIT
chmod 755 "$dir"
printf 'runtime-test-token\r\n' > "$dir/token"
cat > "$dir/Caddyfile" <<'CADDY'
{
  skip_install_trust
}
http://localhost:80 {
  handle /.well-known/security.txt {
    root * /tmp/caddy-security
    file_server
  }
  handle {
    respond "non-root HTTP"
  }
}
https://localhost:443 {
  tls internal
  respond "non-root HTTPS"
}
CADDY
chmod 644 "$dir/token" "$dir/Caddyfile"
for volume in "${volumes[@]}"; do docker volume create "$volume" >/dev/null; done
common=(--read-only --tmpfs /tmp:size=16m --cap-drop ALL
  --security-opt no-new-privileges:true
  --sysctl net.ipv4.ip_unprivileged_port_start=0
  -v "${volumes[0]}:/data" -v "${volumes[1]}:/config"
  -v "$dir/Caddyfile:/etc/caddy/Caddyfile:ro"
  -v "$dir/token:/run/secrets/token:ro"
  -e CLOUDFLARE_API_TOKEN_FILE=/run/secrets/token
  -e SECURITY_CONTACT=mailto:runtime@example.com)
check() {
  local http_port https_port
  http_port=$(docker port "$name" 80/tcp | cut -d: -f2)
  https_port=$(docker port "$name" 443/tcp | cut -d: -f2)
  curl --silent --show-error --fail --retry 20 --retry-connrefused --retry-delay 1 \
    "http://127.0.0.1:$http_port/" | grep -q 'non-root HTTP'
  curl --silent --show-error --fail --insecure \
    "https://127.0.0.1:$https_port/" | grep -q 'non-root HTTPS'
  curl --silent --show-error --fail "http://127.0.0.1:$http_port/.well-known/security.txt" \
    | grep -q 'Contact: mailto:runtime@example.com'
  [[ $(docker exec "$name" id -u) == 10001 ]]
  docker exec "$name" sh -ec '
    grep -Eq "^CapEff:[[:space:]]+0+$" /proc/1/status
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/1/status
    test "$CLOUDFLARE_API_TOKEN_FILE" = /run/secrets/token
    ! touch /etc/must-stay-read-only
    test -r /data/caddy/pki/authorities/local/root.crt
    grep -q ":01BB " /proc/net/udp /proc/net/udp6
  '
}
start() {
  docker run -d --name "$name" "${common[@]}" \
    -p 127.0.0.1::80 -p 127.0.0.1::443/tcp -p 127.0.0.1::443/udp \
    "$image" >/dev/null
  if ! check; then docker logs "$name"; return 1; fi
}
# Fresh volumes take the image's non-root ownership. A restart keeps its CA.
start
before=$(docker exec "$name" sha256sum /data/caddy/pki/authorities/local/root.crt)
docker restart "$name" >/dev/null
check
[[ $(docker exec "$name" sha256sum /data/caddy/pki/authorities/local/root.crt) == "$before" ]]
docker rm -f "$name" >/dev/null
# Reproduce a previous deployment: root-owned directories and mode-600 keys.
# Preserve that real CA/key rather than minting new credentials on migration.
docker run --rm --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --read-only --network none -v "${volumes[0]}:/data" -v "${volumes[1]}:/config" \
  --entrypoint sh "$image" -c 'chown -R 0:0 /data /config; chmod 700 /data/caddy /config/caddy'
if docker run --rm "${common[@]}" "$image" test -r /data/caddy/pki/authorities/local/root.key; then
  echo 'root-owned private key unexpectedly readable by the runtime user' >&2
  exit 1
fi
# The documented one-time migration, with neither network nor other mounts.
docker run --rm --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --read-only --network none -v "${volumes[0]}:/data" -v "${volumes[1]}:/config" \
  --entrypoint chown "$image" -R 10001:10001 /data /config
start
[[ $(docker exec "$name" sha256sum /data/caddy/pki/authorities/local/root.crt) == "$before" ]]
docker exec "$name" sh -c 'test "$(stat -c %a /data/caddy/pki/authorities/local/root.key)" = 600'
echo 'ok: non-root, no capabilities, HTTP/HTTPS/HTTP3 listener, security.txt, restart and existing certificates'
