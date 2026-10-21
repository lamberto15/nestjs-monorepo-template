# syntax=docker/dockerfile:1
# Gotenberg (compose.prod.yaml's `gotenberg`): HTML to PDF with Chromium, for the
# documents the workers render (docs/documents.md). Its official Chromium-only
# image, pinned by version and digest, already carries the fonts the
# documents need (Noto: Latin, Arabic, CJK; emoji). Thin on top of it, as
# backup/ does for supercronic, so the image has no fixable high or critical
# vulnerability when CI scans it (Trivy, like the app image):
#
# - its Debian packages upgraded (Chromium's security releases often follow a
#   Gotenberg release by days);
# - its two Go programs, gotenberg and pdfcpu, built again from the same
#   release tags with a current Go and the golang.org/x modules their fixes
#   are in: a release's binaries carry the Go standard library and modules
#   they were built with.
#
# CI publishes the image it scanned (ghcr.io/<owner>/<repo>/gotenberg), which
# production runs (GOTENBERG_IMAGE); building here is the fallback.
#
# Raising Gotenberg: the FROM line (Dependabot proposes it) and
# GOTENBERG_VERSION together (CI's gotenberg-image job checks they match);
# PDFCPU_VERSION follows Gotenberg's own Dockerfile (build/Dockerfile).

ARG GOTENBERG_VERSION=v8.38.1
ARG PDFCPU_VERSION=v0.15.0

# Built on the build machine's platform for the target's (no emulation). The
# sources come through the Go module proxy, checked against Go's checksum
# database, then the x modules are raised to fixed versions.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24 AS binaries
ARG TARGETOS
ARG TARGETARCH
ARG GOTENBERG_VERSION
ARG PDFCPU_VERSION
ENV CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local
WORKDIR /src
RUN for module in "github.com/gotenberg/gotenberg/v8@$GOTENBERG_VERSION" "github.com/pdfcpu/pdfcpu@$PDFCPU_VERSION"; do \
      dir=$(GOOS= GOARCH= go mod download -json "$module" | grep '"Dir"' | cut -d'"' -f4) \
      && test -n "$dir" \
      && cp -r "$dir" "$(echo "$module" | cut -d/ -f2)" || exit 1; \
    done \
 && chmod -R u+w gotenberg pdfcpu
RUN cd gotenberg \
 && go get golang.org/x/net@v0.61.0 golang.org/x/crypto@v0.58.0 \
 && go build -trimpath -o /out/gotenberg \
      -ldflags "-s -w -X 'github.com/gotenberg/gotenberg/v8/cmd.Version=${GOTENBERG_VERSION#v}'" \
      ./cmd/gotenberg-chromium
RUN cd pdfcpu \
 && go get golang.org/x/crypto@v0.58.0 golang.org/x/image@v0.47.0 \
 && go build -trimpath -o /out/pdfcpu \
      -ldflags "-s -w -X 'main.version=$PDFCPU_VERSION' -X 'github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model.VersionStr=$PDFCPU_VERSION' -X main.builtBy=gotenberg" \
      ./cmd/pdfcpu

FROM gotenberg/gotenberg:8.38.1-chromium@sha256:5da4ab7b8fe7326537369e17b661be765d9a2887f77722faacdbe6d55812fb96
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
COPY --from=binaries /out/gotenberg /usr/bin/gotenberg
COPY --from=binaries /out/pdfcpu /usr/bin/pdfcpu
USER gotenberg
