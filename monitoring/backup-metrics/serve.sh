#!/bin/sh
# The backup service's state as Prometheus metrics (compose.monitoring.yaml,
# service backup-metrics). It reads the markers the backup service writes in
# the backups volume (.last-success, .last-failure: epoch seconds), mounted
# read only, rewrites /www/metrics every minute, and busybox httpd serves it
# on :9102. Prometheus can't see Docker's healthcheck: this is the same check.
set -eu

www=/www
cat >"$www/httpd.conf" <<'EOF'
.txt:text/plain; version=0.0.4; charset=utf-8
EOF

# The epoch seconds a marker holds, 0 when there is none (or it's not a number).
marker() {
  if [ -e "/backups/$1" ] && [ ! -r "/backups/$1" ]; then
    echo "backup-metrics: can't read /backups/$1: run as the backup service's user" >&2
  fi
  value=$(cat "/backups/$1" 2>/dev/null || true)
  case $value in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$value" ;;
  esac
}

max_hours=${BACKUP_MAX_AGE_HOURS:-25}
case $max_hours in
  '' | *[!0-9]*) echo "backup-metrics: BACKUP_MAX_AGE_HOURS must be whole hours" >&2; exit 1 ;;
esac

write() {
  cat >"$www/metrics.tmp" <<EOF
# HELP backup_last_success_timestamp_seconds When the last backup succeeded (0: none yet).
# TYPE backup_last_success_timestamp_seconds gauge
backup_last_success_timestamp_seconds $(marker .last-success)
# HELP backup_last_failure_timestamp_seconds When the last backup failed (0: never).
# TYPE backup_last_failure_timestamp_seconds gauge
backup_last_failure_timestamp_seconds $(marker .last-failure)
# HELP backup_max_age_seconds BACKUP_MAX_AGE_HOURS: how old the last successful backup may get.
# TYPE backup_max_age_seconds gauge
backup_max_age_seconds $((max_hours * 3600))
EOF
  mv "$www/metrics.tmp" "$www/metrics.txt"
}

write
httpd -p 9102 -h "$www" -c "$www/httpd.conf"
trap 'exit 0' TERM INT
while :; do
  sleep 60 &
  wait $!
  write
done
