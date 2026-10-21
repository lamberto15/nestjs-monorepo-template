# syntax=docker/dockerfile:1
# The backup service (compose.prod.yaml): pg_dump from the same PostgreSQL
# image as the server (pg_dump must not be older than the server's major
# version), supercronic as the scheduler (cron syntax, keeps the
# environment, logs to stdout, waits for a running job on SIGTERM), rclone
# for the off-host copy (any S3-compatible store), age for encrypting what
# leaves the host (BACKUP_ENCRYPTION_KEY; Alpine's package, current with the
# base image), pg_basebackup and pg_archivecleanup (in the PostgreSQL image)
# for point-in-time recovery. CI scans it like the app
# image (Trivy: no fixable high or critical vulnerability).

# supercronic built from its release tag with a current Go: the release's
# binaries carry the Go standard library they were built with, and its fixes
# (CVEs) arrive here only when they are rebuilt. go install checks the
# modules against Go's checksum database. Built on the build machine's
# platform for the target's (no emulation).
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24 AS supercronic
ARG TARGETOS
ARG TARGETARCH
# https://github.com/aptible/supercronic/releases
ARG SUPERCRONIC_VERSION=v0.2.49
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local \
    go install -trimpath -ldflags="-s -w -X main.Version=$SUPERCRONIC_VERSION" "github.com/aptible/supercronic@$SUPERCRONIC_VERSION" \
 && install -m 755 "$(find /go/bin -type f -name supercronic)" /supercronic

# rclone built the same way, from its release tag, instead of copied from the
# official image (rclone/rclone): that binary carries the Go standard library
# it was built with (1.27.2 in v1.75.2, the newest release), and CI's scan
# fails on its fixable CVE-2026-111943. Once a release built with Go 1.27.3 or
# newer exists, this can go back to `FROM rclone/rclone:<version> AS rclone`
# and `COPY --from=rclone /usr/local/bin/rclone` (Dependabot raises that FROM).
# Until then Dependabot doesn't see RCLONE_TAG: raise it by hand (not named
# RCLONE_VERSION: rclone reads RCLONE_<FLAG> variables, and that one is its
# --version flag). The build is rclone's own release build (its Makefile and
# bin/cross-compile.go: no build tags, -trimpath, CGO off, and fs.Version set
# to the tag, which is what `rclone version` reports).
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24 AS rclone
ARG TARGETOS
ARG TARGETARCH
# https://github.com/rclone/rclone/releases
ARG RCLONE_TAG=v1.75.2
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local \
    go install -trimpath -ldflags="-s -w -X github.com/rclone/rclone/fs.Version=$RCLONE_TAG" "github.com/rclone/rclone@$RCLONE_TAG" \
 && install -m 755 "$(find /go/bin -type f -name rclone)" /rclone

FROM postgres:18.6-alpine
ENV TZ=UTC BACKUP_DIR=/backups BACKUP_STORAGE_DIR=/storage
COPY --from=rclone /rclone /usr/local/bin/rclone
COPY --from=supercronic /supercronic /usr/local/bin/supercronic
COPY lib.sh /usr/local/lib/backup/lib.sh
COPY --chmod=755 backup.sh /usr/local/bin/backup
COPY --chmod=755 restore.sh /usr/local/bin/restore
COPY --chmod=755 health.sh /usr/local/bin/backup-health
COPY --chmod=755 fetch.sh /usr/local/bin/backup-fetch
COPY --chmod=755 wal-ship.sh /usr/local/bin/backup-wal-ship
COPY --chmod=755 restore-pitr.sh /usr/local/bin/restore-pitr
COPY --chmod=755 entrypoint.sh /usr/local/bin/backup-entrypoint
# /backups: this service's volume. /storage: the app's files volume (read
# only here), owned like the app image's /app/.data/storage (uid 1000, node).
# gosu goes: this image never switches users (USER below), and its old Go
# build is what a scan of the PostgreSQL image finds.
RUN apk add --no-cache age \
 && rm -f /usr/local/bin/gosu \
 && mkdir -p /backups /storage \
 && chown postgres:postgres /backups \
 && chown 1000:1000 /storage
USER postgres
WORKDIR /backups
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=1 CMD ["backup-health"]
ENTRYPOINT ["backup-entrypoint"]
CMD ["schedule"]
