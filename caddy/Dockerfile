# syntax=docker/dockerfile:1
# Built from the repository root (compose.prod.yaml: context `.`, dockerfile
# caddy/Dockerfile; caddy/Dockerfile.dockerignore picks what goes in): Caddy
# with the Cloudflare DNS plugin, and the web app (apps/web) built into /srv/web.

# The web app, built as apps/api/Dockerfile builds the API: the official pnpm
# image, the store in an image layer (#480), the workspace's packages the
# app needs (the typed client, the shared UI).
FROM ghcr.io/pnpm/pnpm:12.16.0 AS web
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=true pnpm fetch --store-dir /pnpm-store
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN CI=true pnpm install --store-dir /pnpm-store --frozen-lockfile --offline \
      --filter @nestjs-monorepo-template/web...
COPY . .
# Only the build output depends on the commit SHA. Leave fetch/install layers
# cacheable when a new commit changes no dependencies.
ARG GIT_SHA=""
RUN pnpm --filter @nestjs-monorepo-template/web... build
# A .br and a .gz beside each asset that compresses
# (apps/web/scripts/precompress.mjs), which the Caddyfile's `precompressed`
# sends: compressed once here, not for each request.
RUN pnpm --filter @nestjs-monorepo-template/web precompress

FROM caddy:2.11.7-builder AS builder
# The Cloudflare DNS plugin is pinned (v0.2.4, its newest release), so two
# builds of one commit are the same image; Dependabot doesn't see a version
# inside this RUN line: raise it by hand, and with it the Caddy release the
# builder and the final stage share (the FROM lines, which Dependabot raises).
# golang.org/x/net raised past the release's (xcaddy's --replace: a replace
# directive, no plugin import), so CI's scan (job caddy-image) finds nothing
# fixable; drop it once a Caddy release ships this version or a newer one.
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4 \
      --replace golang.org/x/net=golang.org/x/net@v0.61.0

FROM caddy:2.11.7
# Stable IDs also used by the one-time certificate-volume migration.
RUN apk upgrade --no-cache brotli-libs curl libcurl \
 && addgroup -S -g 10001 caddy \
 && adduser -S -D -H -u 10001 -G caddy caddy \
 && chown -R 10001:10001 /data /config
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# The upstream binary carries a file capability; it cannot exec with cap_drop ALL.
# Low ports are allowed by the service network namespace instead.
RUN setcap -r /usr/bin/caddy
# The Cloudflare token from the environment or a file (a Docker secret).
COPY --chmod=755 caddy/entrypoint.sh /usr/local/bin/caddy-entrypoint
# The static files the Caddyfile serves for every path that isn't the API's.
COPY --from=web /app/apps/web/dist /srv/web
# The page the Caddyfile answers (503) for the web app's paths while
# MAINTENANCE_PAGE=on: static, one file (docs/deployment.md, "Maintenance page").
COPY caddy/maintenance.html /srv/maintenance/index.html
USER 10001:10001
ENTRYPOINT ["caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
