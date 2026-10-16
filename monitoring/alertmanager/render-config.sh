#!/bin/sh
# Alertmanager reads no environment variables, so this writes its
# configuration from them (compose.monitoring.yaml passes them from .env),
# then starts it with the arguments given. The secrets stay out of git and
# out of the image: the file is written to a tmpfs inside the container.
#
#   ALERT_EMAIL_TO           where alert mail goes (comma-separated); empty: no mail
#   ALERT_SMTP_URL           the SMTP server, as the app's SMTP_URL (its default):
#                            smtp:// (STARTTLS, port 587 unless given) or smtps://
#                            (port 465), user and percent-encoded password in it;
#                            SMTP_URL_FILE: the app's from its file (a CRLF dropped)
#   ALERT_SMTP_REQUIRE_TLS   true (default), or false for a local relay without STARTTLS
#   ALERT_EMAIL_FROM         the sender (default: MAIL_FROM)
#   ALERT_WEBHOOK_URL        a generic webhook (Alertmanager's JSON); empty: none
#   ALERT_SLACK_WEBHOOK_URL  a Slack incoming webhook; empty: none
#
# None set: alerts are only visible in Alertmanager and Prometheus.
#
# The dead man's switch: the Watchdog alert always fires, and goes to its own
# receiver only, about once a minute (healthchecks.io's ping URL), never to
# the ones above. Its URL, preferred first:
#
#   /run/secrets/alert_watchdog_url  a Docker secret holding the URL (url_file:
#                                    Alertmanager reads it, it is never copied)
#   ALERT_WATCHDOG_URL               the URL itself
#
# Neither (or an empty secret): the Watchdog still fires, to a receiver that
# sends nothing.
# Check the result without starting: render-config.sh --check (amtool).
set -eu

out=${ALERTMANAGER_CONFIG:-/tmp/alertmanager.yml}
watchdog_file=/run/secrets/alert_watchdog_url

# A YAML single-quoted scalar: '' inside, nothing else is special.
quote() {
  printf "'%s'" "$(printf %s "$1" | sed "s/'/''/g")"
}

# %40 -> @ and the like (URL userinfo is percent-encoded).
percent_decode() {
  printf '%b' "$(printf %s "$1" | sed 's/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')"
}

email_to=${ALERT_EMAIL_TO:-}
# The app's SMTP_URL may be in a file (compose.prod.yaml): read like the app does.
if [ -n "${SMTP_URL_FILE:-}" ]; then
  if [ -n "${SMTP_URL:-}" ]; then
    echo "render-config: SMTP_URL and SMTP_URL_FILE are both set: keep one" >&2
    exit 1
  fi
  cr=$(printf '\r')
  if ! SMTP_URL=$(cat "$SMTP_URL_FILE") || ! SMTP_URL=${SMTP_URL%"$cr"} || [ -z "$SMTP_URL" ]; then
    echo "render-config: SMTP_URL_FILE: can't read $SMTP_URL_FILE, or it is empty" >&2
    exit 1
  fi
fi
smtp_url=${ALERT_SMTP_URL:-${SMTP_URL:-}}
email_from=${ALERT_EMAIL_FROM:-${MAIL_FROM:-}}
webhook_url=${ALERT_WEBHOOK_URL:-}
slack_url=${ALERT_SLACK_WEBHOOK_URL:-}

integrations=''

if [ -n "$email_to" ]; then
  case "$smtp_url" in
    smtp://* | smtps://*) ;;
    *)
      echo "render-config: ALERT_EMAIL_TO is set, but ALERT_SMTP_URL (or SMTP_URL) is not an smtp:// or smtps:// URL" >&2
      exit 1
      ;;
  esac
  if [ -z "$email_from" ]; then
    echo "render-config: ALERT_EMAIL_TO is set, but neither ALERT_EMAIL_FROM nor MAIL_FROM" >&2
    exit 1
  fi
  require_tls=${ALERT_SMTP_REQUIRE_TLS:-true}
  case "$require_tls" in
    true | false) ;;
    *)
      echo "render-config: ALERT_SMTP_REQUIRE_TLS must be true or false" >&2
      exit 1
      ;;
  esac
  scheme=${smtp_url%%://*}
  rest=${smtp_url#*://}
  rest=${rest%%/*}
  rest=${rest%%\?*}
  userinfo=''
  case "$rest" in
    *@*)
      userinfo=${rest%@*}
      rest=${rest##*@}
      ;;
  esac
  host=$rest
  case "$host" in
    *:*) ;;
    *) if [ "$scheme" = smtps ]; then host="$host:465"; else host="$host:587"; fi ;;
  esac
  integrations="$integrations
    email_configs:
      - to: $(quote "$email_to")
        from: $(quote "$email_from")
        smarthost: $(quote "$host")
        require_tls: $require_tls
        send_resolved: true"
  if [ "$scheme" = smtps ]; then
    integrations="$integrations
        force_implicit_tls: true"
  fi
  if [ -n "$userinfo" ]; then
    integrations="$integrations
        auth_username: $(quote "$(percent_decode "${userinfo%%:*}")")"
    case "$userinfo" in
      *:*)
        integrations="$integrations
        auth_password: $(quote "$(percent_decode "${userinfo#*:}")")"
        ;;
    esac
  fi
fi

if [ -n "$webhook_url" ]; then
  integrations="$integrations
    webhook_configs:
      - url: $(quote "$webhook_url")
        send_resolved: true"
fi

if [ -n "$slack_url" ]; then
  integrations="$integrations
    slack_configs:
      - api_url: $(quote "$slack_url")
        send_resolved: true
        title: '{{ if eq .Status \"firing\" }}[{{ .CommonLabels.severity | toUpper }}]{{ else }}[RESOLVED]{{ end }} {{ .CommonLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.summary }}: {{ .Annotations.description }}{{ \"\\n\" }}{{ end }}'"
fi

if [ -z "$integrations" ]; then
  echo "render-config: no receiver configured (ALERT_EMAIL_TO, ALERT_WEBHOOK_URL, ALERT_SLACK_WEBHOOK_URL): alerts are only shown in Alertmanager" >&2
fi

# The URL must be a URL: a typo would otherwise only show up as failed
# notifications (AlertmanagerNotificationsFailing).
check_watchdog_url() {
  case "$1" in
    https://* | http://*) ;;
    *)
      echo "render-config: the Watchdog URL ($2) must start with https:// or http://" >&2
      exit 1
      ;;
  esac
}

# Mounted but unreadable (a chmod 600 file of another user): say so, rather
# than run without the switch.
if [ -e "$watchdog_file" ] && [ ! -r "$watchdog_file" ]; then
  echo "render-config: the alert_watchdog_url secret is not readable by uid $(id -u) (chmod 644 the file ALERT_WATCHDOG_URL_FILE names)" >&2
  exit 1
fi

# No resolved message: healthchecks.io would read any request as a ping.
watchdog=''
if [ -r "$watchdog_file" ] && grep -q '[^[:space:]]' "$watchdog_file"; then
  check_watchdog_url "$(tr -d '[:space:]' <"$watchdog_file")" "the alert_watchdog_url secret"
  watchdog="
    webhook_configs:
      - url_file: $(quote "$watchdog_file")
        send_resolved: false
        timeout: 10s"
elif [ -n "${ALERT_WATCHDOG_URL:-}" ]; then
  check_watchdog_url "$ALERT_WATCHDOG_URL" ALERT_WATCHDOG_URL
  watchdog="
    webhook_configs:
      - url: $(quote "$ALERT_WATCHDOG_URL")
        send_resolved: false
        timeout: 10s"
else
  echo "render-config: no Watchdog URL (the alert_watchdog_url secret, ALERT_WATCHDOG_URL): no dead man's switch" >&2
fi

umask 077
cat >"$out" <<EOF
# Written by render-config.sh at start: edit that script, not this file.
route:
  receiver: default
  # One notification per alert name and deployment, several firing
  # instances batched together.
  group_by: [alertname, environment, job, queue]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  routes:
    # The dead man's switch, first and on its own: the external check
    # expects a ping every minute and alarms when they stop (Prometheus,
    # Alertmanager or the host down). The repeat is shorter than the group
    # interval on purpose: it then goes at every group interval, once a
    # minute (1m and 1m send it every 2 minutes, measured). Alertmanager
    # logs a warning about it at start; that is expected.
    - matchers: ['alertname="Watchdog"']
      receiver: watchdog
      group_by: [alertname]
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 50s
    # Critical ones come back sooner while they last.
    - matchers: ['severity="critical"']
      repeat_interval: 2h

inhibit_rules:
  # A critical alert mutes a warning of the same name.
  - source_matchers: ['severity="critical"']
    target_matchers: ['severity="warning"']
    equal: [alertname]
  # No api (or worker) at all: its per-target alerts say nothing more.
  - source_matchers: ['alertname=~"ApiDown|WorkerDown"']
    target_matchers: ['alertname="TargetDown"']
    equal: [job]
  # A store down: the app's view of it is the same news.
  - source_matchers: ['alertname="PostgresDown"']
    target_matchers: ['alertname="DatabaseUnreachableFromApp"']
  - source_matchers: ['alertname="RedisDown"']
    target_matchers: ['alertname="RedisUnreachableFromApp"']
  # No api, or no store: Caddy has no healthy replica (it checks /health),
  # so the HTTPS probe fails as well, for the reason already sent. Only
  # these whole-stack alerts: a per-instance one (DatabaseUnreachableFromApp
  # on one replica) must not hide a Caddy or certificate outage.
  - source_matchers: ['alertname=~"ApiDown|PostgresDown|RedisDown"']
    target_matchers: ['alertname="HttpsProbeFailing"']

receivers:
  - name: default$integrations
  - name: watchdog$watchdog
EOF

if [ "${1:-}" = --check ]; then
  exec amtool check-config "$out"
fi
exec /bin/alertmanager --config.file="$out" "$@"
