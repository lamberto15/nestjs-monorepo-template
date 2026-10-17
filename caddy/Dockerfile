# syntax=docker/dockerfile:1
# Built from the repository root (compose.prod.yaml: context `.`, dockerfile
# caddy/Dockerfile; caddy/Dockerfile.dockerignore picks what goes in): Caddy
# with the Cloudflare DNS plugin, and the web app (apps/web) built into /srv/web.

# The web app, built as apps/api/Dockerfile builds the API: the official pnpm
# image, the store in a BuildKit cache mount, the workspace's packages the
# app needs (the typed client, the shared UI).
FROM ghcr.io/pnpm/pnpm:12.11.2 AS web
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    CI=true pnpm fetch --store-dir /var/cache/pnpm
COPY . .
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    CI=true pnpm install --store-dir /var/cache/pnpm --frozen-lockfile --offline \
      --filter @nestjs-monorepo-template/web...
RUN pnpm --filter @nestjs-monorepo-template/web... build

FROM caddy:2.11.7-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.11.7
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# The Cloudflare token from the environment or a file (a Docker secret).
COPY --chmod=755 caddy/entrypoint.sh /usr/local/bin/caddy-entrypoint
# The static files the Caddyfile serves for every path that isn't the API's.
COPY --from=web /app/apps/web/dist /srv/web
ENTRYPOINT ["caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
