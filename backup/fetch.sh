#!/bin/sh
# The off-host copies (BACKUP_S3_*), for a restore on a new host:
#
#   backup-fetch          lists them, newest first
#   backup-fetch <name>   copies one (and its .sha256) into /backups
#
# Listing and reading need keys allowed to list and read the bucket (the
# backup's own may be write-only).
set -eu
# shellcheck source=lib.sh
. /usr/local/lib/backup/lib.sh
umask 077
offsite_setup

if [ $# -eq 0 ]; then
  rclone lsf --quiet --files-only --format tsp --separator ' ' "$OFFSITE" | grep -v '\.sha256$' | sort -r
  exit 0
fi
name=$(basename "$1")
rclone copyto --quiet "$OFFSITE/$name" "$BACKUP_DIR/$name"
if ! rclone copyto --quiet "$OFFSITE/$name.sha256" "$BACKUP_DIR/$name.sha256"; then
  log warn "no checksum file next to the backup" file="$name"
fi
log info "fetched" file="$name" from="$OFFSITE_URL" path="$BACKUP_DIR/$name"
