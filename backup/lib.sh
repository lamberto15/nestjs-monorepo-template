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
# The age recipient(s) the backups are encrypted to (public keys: the server
# can encrypt, never decrypt), from the file too.
secret_from_file BACKUP_ENCRYPTION_KEY

# Point-in-time recovery (compose.pitr.yaml): BACKUP_PITR=on|off.
pitr_on() {
  case ${BACKUP_PITR:-off} in
    on) return 0 ;;
    off | '') return 1 ;;
    *)
      log error "BACKUP_PITR must be on or off" value="$BACKUP_PITR"
      exit 2
      ;;
  esac
}
WAL_DIR=${BACKUP_WAL_DIR:-/wal}

# Client-side encryption with age (https://age-encryption.org): with
# BACKUP_ENCRYPTION_KEY set (one or more recipients), every dump, archive,
# base backup and WAL segment is encrypted before it is kept or uploaded, so
# the bucket never holds plaintext. Restoring needs the matching identity
# (BACKUP_DECRYPTION_KEY, or a file: BACKUP_DECRYPTION_KEY_FILE), given at
# restore time only.
#
# The recipients are read a line at a time: a line starting with "age1" may
# hold several keys, separated by spaces; any other line is ONE recipient,
# whole, because an ssh public key has spaces in it ("ssh-ed25519 AAAA… me@laptop").
# Blank lines and # comments are skipped, as in age's own recipients files.
encryption_on() { [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; }

# age_encrypt <in> <out>
age_encrypt() {
  in=$1
  out=$2
  recipients=$(printf '%s\n' "$BACKUP_ENCRYPTION_KEY" | tr -d '\r')
  set --
  while read -r line; do
    case $line in
      '' | '#'*) ;;
      age1*) for recipient in $line; do set -- "$@" -r "$recipient"; done ;;
      *) set -- "$@" -r "$line" ;;
    esac
  done <<EOF
$recipients
EOF
  age "$@" -o "$out" "$in"
}

# Sets IDENTITY to a file holding the age identity (a temporary one when it
# came from the variable: IDENTITY_TMP, for the caller to remove).
# shellcheck disable=SC2034 # IDENTITY, IDENTITY_TMP: for the callers
age_identity() {
  IDENTITY_TMP=''
  if [ -n "${BACKUP_DECRYPTION_KEY_FILE:-}" ]; then
    IDENTITY=$BACKUP_DECRYPTION_KEY_FILE
  elif [ -n "${BACKUP_DECRYPTION_KEY:-}" ]; then
    IDENTITY_TMP=$(umask 077 && mktemp)
    printf '%s\n' "$BACKUP_DECRYPTION_KEY" >"$IDENTITY_TMP"
    IDENTITY=$IDENTITY_TMP
  else
    log error "the backup is encrypted: set BACKUP_DECRYPTION_KEY (the age identity, AGE-SECRET-KEY-…) or BACKUP_DECRYPTION_KEY_FILE"
    exit 2
  fi
  if [ ! -r "$IDENTITY" ]; then
    log error "BACKUP_DECRYPTION_KEY_FILE: can't read the file" file="$IDENTITY"
    exit 2
  fi
}
