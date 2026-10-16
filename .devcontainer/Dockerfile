# The devcontainer's workspace (devcontainer.json, docs/development.md,
# "Devcontainer"): Node.js 24 (package.json's devEngines.runtime, the API
# image's node:24), pnpm at devEngines.packageManager's version, psql and
# redis-cli. The base image has the `node` user, sudo and git. Dependabot
# raises the FROM line; raise PNPM_VERSION with devEngines by hand.
FROM mcr.microsoft.com/devcontainers/javascript-node:5.2.3-24-trixie

ARG PNPM_VERSION=12.11.2
RUN npm install --global --force pnpm@${PNPM_VERSION} \
  && apt-get update \
  && apt-get install --yes --no-install-recommends postgresql-client redis-tools \
  && rm -rf /var/lib/apt/lists/*
