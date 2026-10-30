# The devcontainer's workspace (devcontainer.json, docs/development.md,
# "Devcontainer"): Node.js 26 (package.json's devEngines.runtime, the API
# image's node:26), pnpm at devEngines.packageManager's version, psql and
# redis-cli. The base image has the `node` user, sudo and git. Dependabot
# raises the FROM line; raise PNPM_VERSION with devEngines by hand.
FROM mcr.microsoft.com/devcontainers/javascript-node:5.2.5-26-trixie

ARG PNPM_VERSION=12.15.0
RUN npm install --global --force pnpm@${PNPM_VERSION} \
  && apt-get update \
  && apt-get install --yes --no-install-recommends postgresql-client redis-tools \
  && rm -rf /var/lib/apt/lists/*

# The base image's non-root user, as devcontainer.json's remoteUser.
USER node
