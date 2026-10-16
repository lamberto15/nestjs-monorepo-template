#!/bin/sh
# The inhibition rules render-config.sh writes, against a real Alertmanager:
# alerts are posted with amtool and each one's state read back (active or
# suppressed). amtool can't test inhibition offline. Runs in the pinned
# image (.github/workflows/monitoring.yml):
#
#   docker run --rm -v "$PWD/monitoring/alertmanager:/etc/alertmanager/scripts:ro" \
#     --entrypoint sh prom/alertmanager:<tag> /etc/alertmanager/scripts/tests/inhibition.sh
set -eu

am=http://127.0.0.1:9093
config=/tmp/alertmanager.yml

ALERTMANAGER_CONFIG=$config sh /etc/alertmanager/scripts/render-config.sh --check >/tmp/render.log 2>&1 || {
  cat /tmp/render.log >&2
  exit 1
}
/bin/alertmanager --config.file="$config" --storage.path=/tmp/am-data \
  --cluster.listen-address= --web.listen-address=127.0.0.1:9093 >/tmp/am.log 2>&1 &

i=0
until wget -qO- "$am/-/ready" >/tmp/ready 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    cat /tmp/am.log >&2
    echo "inhibition: Alertmanager did not start" >&2
    exit 1
  fi
  sleep 1
done

add() {
  amtool --alertmanager.url="$am" alert add "$@"
}

# expect <state> <matchers...>: the (one) alert they match has that state.
failed=0
expect() {
  want=$1
  shift
  out=$(amtool --alertmanager.url="$am" alert query --active --inhibited --silenced -o json "$@")
  case "$out" in
    *"\"state\":\"$want\""*) echo "ok: $* is $want" ;;
    *)
      echo "FAILED: $* should be $want: $out" >&2
      failed=1
      ;;
  esac
}

probe='instance=https://caddy:443/health/live'

# One replica that can't read its stores: not a reason to hide the probe.
add alertname=HttpsProbeFailing severity=critical job=probe "$probe"
add alertname=DatabaseUnreachableFromApp severity=critical job=worker instance=10.0.0.4:3000
add alertname=RedisUnreachableFromApp severity=critical job=api instance=10.0.0.2:3000
expect active alertname=HttpsProbeFailing

# A critical certificate alert mutes the warning of the same name.
add alertname=CertificateExpiring severity=warning job=probe "$probe"
add alertname=CertificateExpiring severity=critical job=probe "$probe"
expect suppressed alertname=CertificateExpiring severity=warning
expect active alertname=CertificateExpiring severity=critical

# No api at all: Caddy has nothing healthy behind it, ApiDown says why.
add alertname=ApiDown severity=critical job=api
expect suppressed alertname=HttpsProbeFailing

exit "$failed"
