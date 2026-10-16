# Shared by backup, restore and backup-health (sourced, not run).

BACKUP_DIR=${BACKUP_DIR:-/backups}

# JSON-escapes a value: backslashes, quotes; control characters dropped.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'
}

# One JSON line on stdout, like the app's logs:
#   log info "backup done" file=db-x.dump bytes=123
# Values made of digits only are written as numbers.
log() {
  level=$1
  msg=$2
  shift 2
  fields=''
  for pair in "$@"; do
    key=${pair%%=*}
    value=${pair#*=}
    case $value in
      '' | *[!0-9]*) fields="$fields,\"$key\":\"$(json_escape "$value")\"" ;;
      *) fields="$fields,\"$key\":$value" ;;
    esac
  done
  printf '{"time":"%s","level":"%s","service":"backup","msg":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$(json_escape "$msg")" "$fields"
}

# Epoch seconds of the last successful / failed run (0: none yet).
last_success() {
  if [ -s "$BACKUP_DIR/.last-success" ]; then cat "$BACKUP_DIR/.last-success"; else echo 0; fi
}
last_failure() {
  if [ -s "$BACKUP_DIR/.last-failure" ]; then cat "$BACKUP_DIR/.last-failure"; else echo 0; fi
}

# Whole hours or days only, so a typo stops the run instead of keeping nothing.
require_number() {
  case $2 in
    '' | *[!0-9]*)
      log error "$1 must be a whole number" value="$2"
      exit 2
      ;;
  esac
}

# rclone's remote "offsite", from BACKUP_S3_* (no config file). Sets OFFSITE
# (rclone's path: offsite:bucket/prefix) and OFFSITE_URL (for the logs).
# no_check_bucket: rclone never lists or creates the bucket, so keys that
# may only write objects work. env_auth: without keys, the instance's role.
# shellcheck disable=SC2034 # OFFSITE and OFFSITE_URL: for the callers
offsite_setup() {
  if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
    log error "BACKUP_S3_BUCKET is not set: no off-host copies"
    exit 2
  fi
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then provider=Other; else provider=AWS; fi
  export RCLONE_CONFIG_OFFSITE_TYPE=s3
  export RCLONE_CONFIG_OFFSITE_PROVIDER="${BACKUP_S3_PROVIDER:-$provider}"
  export RCLONE_CONFIG_OFFSITE_ENV_AUTH=true
  export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_OFFSITE_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_OFFSITE_REGION="${BACKUP_S3_REGION:-}"
  export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
  export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  prefix=${BACKUP_S3_PREFIX:-}
  prefix=${prefix%/}
  OFFSITE="offsite:$BACKUP_S3_BUCKET${prefix:+/$prefix}"
  OFFSITE_URL="s3://$BACKUP_S3_BUCKET${prefix:+/$prefix}/"
}

# A secret from a file: with NAME_FILE set (a Docker secret, compose.prod.yaml),
# NAME becomes the file's contents (trailing line breaks dropped, a CRLF too), like the
# app's X_FILE variables. Both set is an error; the value is never logged.
secret_from_file() {
  name=$1
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || return 0
  eval "value=\${${name}:-}"
  if [ -n "$value" ]; then
    log error "$name and ${name}_FILE are both set: keep one"
    exit 2
  fi
  cr=$(printf '\r')
  if ! value=$(cat "$file" 2>/dev/null) || ! value=${value%"$cr"} || [ -z "$value" ]; then
    log error "${name}_FILE: can't read $file, or it is empty"
    exit 2
  fi
  export "$name=$value"
  unset "${name}_FILE"
}

# libpq's password (the stack's database) and the off-host copy's key.
secret_from_file PGPASSWORD
secret_from_file BACKUP_S3_SECRET_ACCESS_KEY
