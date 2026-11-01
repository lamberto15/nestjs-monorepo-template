# syntax=docker/dockerfile:1
# Gotenberg (compose.prod.yaml's `gotenberg`): HTML to PDF with Chromium, for the
# documents the workers render (docs/documents.md). Its official Chromium-only
# image, pinned by version and digest, already carries the fonts the
# documents need (Noto: Latin, Arabic, CJK; emoji). Thin on top of it, as
# backup/ does for supercronic: its Debian packages upgraded, since Chromium's
# security releases often follow a Gotenberg release by days.
#
# CI publishes the image it scanned (ghcr.io/<owner>/<repo>/gotenberg), which
# production runs (GOTENBERG_IMAGE); building here is the fallback.
#
# Raising Gotenberg: the FROM line (Dependabot proposes it) and compose.dev.yaml's
# image together (CI's gotenberg-image job checks they match).

FROM gotenberg/gotenberg:8.39.0-chromium@sha256:558943677cf9092df83ff654c2645856dcb9ddf777f359243789688e74f3bcdd
USER root
# Changes the Debian step's cache key: CI passes a new value per run, so the
# upgrade below is today's, not the first build's. A local build without it
# reuses its cache: `docker compose build --no-cache gotenberg` (or run the
# image CI published, GOTENBERG_IMAGE).
ARG APT_REFRESH=
# Debian's current security updates (the image's sources are the live
# archives). An archive that can't be read fails the build, rather than
# leaving the packages as they were.
RUN echo "Debian packages as of run ${APT_REFRESH:-local}" \
 && apt-get update -qq --error-on=any \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -yqq --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
 && bash /opt/gotenberg/capture-version.sh "$GOTENBERG_VERSIONS_DIR_PATH" chromium "$CHROMIUM_BIN_PATH" --version
USER gotenberg
