#!/bin/sh
# Runs once, when the devcontainer is created (devcontainer.json).
set -eu

# The dependency volumes (compose.yaml) are made by root: the node user installs into them.
sudo chown node:node node_modules apps/api/node_modules packages/api-client/node_modules
pnpm install

# The app's development settings, from their template, unless you have them
# already (the bind mount brings yours). The services' addresses come from
# the container's environment, which wins over the file's 127.0.0.1.
if [ ! -f apps/api/.env.development ]; then
  cp apps/api/env.development.example apps/api/.env.development
  echo 'Made apps/api/.env.development from apps/api/env.development.example: review it.'
fi

cat <<'TEXT'

Ready. From /workspace:
  pnpm start:dev        the API and the workers: http://localhost:3000/api
  pnpm db:seed:demo     demo users and notes (their passwords are printed once)
  pnpm test:e2e         on this container's PostgreSQL and Redis
TEXT
