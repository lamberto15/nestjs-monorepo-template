#!/usr/bin/env bash
# Encryption and point-in-time recovery of the backup service, end to end
# (backup/test-pitr.sh) in the backup image, against a throwaway PostgreSQL
# inside it. An rclone stand-in plays the bucket.
#
#   scripts/test-backup-pitr.sh [image]      (Docker; image: default backup:ci,
#                                             build it: docker build -t backup:ci backup)
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:-backup:ci}
# As the image runs (postgres, which initdb needs); the server's binaries are on its PATH.
docker run --rm --user postgres -v "$PWD/backup/test-pitr.sh:/test-pitr.sh:ro" --entrypoint sh "$image" /test-pitr.sh
