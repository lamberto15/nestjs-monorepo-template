# Docker Swarm

The production stack on Docker Swarm: rolling updates of `api` and `worker`
with no stopped capacity, an automatic rollback when a new version doesn't
become healthy, and the same configuration as the Compose deployment
([deployment.md](deployment.md)). One node or several.

```bash
pnpm deploy:swarm            # migrate, deploy, wait; exit 0 only when every service converged
pnpm deploy:swarm check      # render and validate the stack file (no Swarm needed)
pnpm deploy:swarm status
pnpm deploy:swarm rollback   # api and worker to their previous version
```

## How it is built

`compose.swarm.yaml` is an overlay on `compose.yaml` and `compose.prod.yaml`,
not a stack file of its own, so the environment, secrets and limits stay
declared once. `docker stack` can't read those files by itself: it lacks
`${X:+y}` and nested defaults (`invalid interpolation format`), which they
use. `tools/deploy` renders the three files with `docker compose config`,
adapts what `docker stack deploy` still refuses (`tools/deploy/render.mjs`:
numbers as strings, no nulls, versioned secrets) and pipes the result to
`docker stack config` and `docker stack deploy -c -`. Because Compose renders
it, `.env` is read as usual (`--env-file <path>` for another).

What Swarm lacks, and what replaces it:

| Compose | Swarm |
| --- | --- |
| `build:` | Images are pulled: `APP_IMAGE`, `GOTENBERG_IMAGE`, `BACKUP_IMAGE`, `CADDY_IMAGE` are required, pushed to a registry first (below). `--with-registry-auth` hands a private registry's login to the nodes. |
| `depends_on` | Ignored. A task that starts before PostgreSQL or Redis fails its healthcheck or exits, and `restart_policy` retries it. |
| one-shot `migrate` | A `replicated-job` service the script deploys and waits for before the app is touched. |
| bind mounts (`Caddyfile`, `redis.sh`) | Swarm configs. |
| `restart:` | `deploy.restart_policy` (any, 5 s). |
| `.env` secrets as files | Swarm secrets, from the same files (`X_FILE` in `.env`). |

## Images

CI publishes the app, Gotenberg and Caddy images to GHCR
([deployment.md](deployment.md), "CI"); `CADDY_IMAGE` is the published
`ghcr.io/<owner>/<repo>/caddy:<full commit SHA>` (Caddy with the Cloudflare DNS
module and the web app; nothing in it is one deployment's). The backup service
is built from `backup/` by you, once per change of that directory, and pushed:

```bash
docker build -t ghcr.io/<owner>/<repo>/backup:1 backup && docker push ghcr.io/<owner>/<repo>/backup:1
```

`.env` (or the shell): `APP_IMAGE=ghcr.io/<owner>/<repo>:<full commit SHA>`,
`GOTENBERG_IMAGE`, `CADDY_IMAGE` (the same commit as `APP_IMAGE`: it holds the web
build that fits that API), `BACKUP_IMAGE`. Never `latest`: a deploy
names the version it runs, and a rollback goes back to the one before it.

## One node

```bash
docker swarm init
docker node update --label-add stateful=true $(docker node ls -q)
cp env.example .env     # fill it, as for Compose; APP_IMAGE etc. as above
pnpm deploy:swarm
```

Stop the Compose stack first if it runs on the same host (ports 80 and 443).

**Never `docker swarm init` or `docker swarm leave` on a host where a Compose
stack keeps running.** It happened on the template's own instance: after
Swarm was turned on and off, Docker's embedded DNS no longer answered for the
containers already on the Compose networks (`nslookup postgres` → NXDOMAIN).
The next `docker compose up` recreated the app, its migration failed with
`getaddrinfo ENOTFOUND postgres`, and the site was down. Move to Swarm as a
cut-over (stop Compose, init, deploy, restore), and try Swarm out on another
machine or VM. Repair, if it happens: reconnect each running container to its
network under its service name (`docker network disconnect <net> <c>`, then
`docker network connect --alias <service> <net> <c>`), or restart Docker; then
`docker compose up -d`. A second `docker swarm init` on Docker Desktop may also
fail with `error creating vxlan interface: file exists` (a device the last
swarm left): restart Docker Desktop.
Swarm names its volumes `<stack>_postgres_data` and so on: a Compose
deployment's data is not found under those names (restore a backup into the
new PostgreSQL, [deployment.md](deployment.md), "Backups and restore").

## Several nodes

PostgreSQL, Redis, Caddy, the backups and the uploaded files are local
volumes: they stay on the node labelled `stateful=true`
(`SWARM_STATEFUL_CONSTRAINT` changes the rule). `pnpm deploy:swarm` refuses
to start when no node has the label. Everything else runs anywhere:

- `api`, `worker` and `gotenberg` are free (`SWARM_APP_CONSTRAINT` limits
  them; `API_MAX_PER_NODE` spreads the replicas).
- **Files:** with `STORAGE_DRIVER=local` the `app_storage` volume exists on one
  node only, so `api` and `worker` must run there too:
  `SWARM_APP_CONSTRAINT='node.labels.stateful == true'`. With `s3` they spread.
- **Caddy** publishes 80, 443 and 443/udp in host mode (it sees client
  addresses; nothing else publishes a port) and is one task on the stateful
  node: point DNS there. Put a load balancer in front for more.
- **Network:** the overlay networks need 2377/tcp, 7946/tcp+udp and 4789/udp
  between nodes. Encrypt the data plane with `docker network create` options
  only if you create the networks yourself.
- A single PostgreSQL is a single point of failure: past one node, use managed
  PostgreSQL and Redis (`DATABASE_URL`, `REDIS_URL`) and drop both services.

## Secrets

As in Compose ([configuration.md](configuration.md), "Secrets"): `X_FILE` in
`.env` names a file on the host, mounted at `/run/secrets/x`. Swarm secrets
are immutable, so each is named `<stack>_<name>_<hash of its content>`:
an unchanged file is the same secret (no restart), a changed one is a new
secret and the services using it are updated by the same rolling update.
Unset ones use `swarm.placeholder` (Swarm refuses an empty secret); the app
never reads them. Run the script on a manager, from a checkout that has the
files.

## Deploying

`pnpm deploy:swarm`:

1. Renders and validates (`docker stack config`), checks this Docker is a
   manager and a node carries the stateful label.
2. Deploys the stores (PostgreSQL, Redis, Gotenberg, backup) and the
   **migrations as a job** (`replicated-job`, retried 12 times, 5 s apart, so
   it waits for PostgreSQL on a first deploy). A failed job stops the deploy
   before the app is touched.
3. Deploys the app (`api`, `worker`, `caddy`) and waits: per service `ok`,
   `rolled-back` (exit 1), `paused` (exit 3) or a timeout (`--timeout`, 600 s).

Migrations run before the new code does, with the old code still serving: keep
them expand/contract ([deployment.md](deployment.md), "Migrations").

Options: `--stack <name>` (`SWARM_STACK`, default `app`), `--env-file <path>`,
`--timeout <seconds>` (600), `--prune` (remove services the stack file no
longer has) and `--skip-migrate`.

### Rolling updates and rollback

`api` and `worker`: `update_config` is one task at a time, `start-first` (the
new task runs and is healthy before an old one stops), `delay` 10 s,
`monitor` 60 s (`SWARM_MONITOR`), `failure_action: rollback`. `rollback_config`
is the same shape. A new task that doesn't pass its healthcheck, or that dies
inside the monitor window, rolls the service back to the previous spec by
itself; the script reports it and exits 1.

The healthcheck is **readiness** (`/health`: PostgreSQL and Redis answer), not
the image's liveness, so a version that can't reach its stores never becomes
healthy. The price: Swarm replaces an unhealthy task, so a PostgreSQL outage
restarts the tasks (every 5 s) until it is back. `api` uses `endpoint_mode:
dnsrr`: `api` resolves to every task, which Caddy's `dynamic a` needs (the
sticky cookie picks one); the routing mesh's single address would hide them.

PostgreSQL, Redis, Caddy and the backup are `stop-first` (one volume, host
ports): updating them is a short outage, and a Caddy update drops connections
for about two seconds. Update them rarely.

`pnpm deploy:swarm rollback` (`--service api` for one) is `docker service
rollback`: the previous image and settings. The database is not rolled back.

## Resource limits

`deploy.resources` are compose.prod.yaml's `*_CPUS` and `*_MEMORY`
([deployment.md](deployment.md), "Resource limits"). Swarm schedules by
reservations, which are unset: it doesn't place tasks by their limits.

## Limits of this setup

- The backup service's healthcheck is off: Swarm would kill an unhealthy
  container, and with it a running backup. Check it with
  `docker exec <container> backup-health`, or alert on the logs.
- `security_opt: no-new-privileges` (Gotenberg and every other service,
  [deployment.md](deployment.md), "Container hardening") has no Swarm
  equivalent and is dropped; the rest of the hardening (read-only, tmpfs,
  `cap_drop`/`cap_add`, Gotenberg's internal network) is kept. It needs
  Docker 27 or newer, whose services accept capabilities.
- Secrets changes need the script (or `docker stack deploy`) to run again.
- The measurements below are from a one-node swarm on a laptop.

## Measured

On a one-node swarm (2 api replicas, 1 worker), three clients at about 9
requests a second to `GET /v1/account` without credentials (a real route:
401 expected) through Caddy, during each deploy:

| Deploy | Requests | Unexpected |
| --- | --- | --- |
| api image update, run 1 | 1251 | 0 |
| api image update, run 2 | 1251 | 0 |
| a version that never becomes healthy | 1289 (probing `/health/live`) | 0: one new task tried and failed, the old two kept serving; `rollback_completed`, exit 1 |
| Caddy update (new Caddyfile) | 1212 (probing `/health/live`) | 13, about two seconds of refused connections |

Probe a real route, not `/health` or `/health/live`: a draining replica
answers 503 on both by design while it still serves real requests, so an
earlier measurement with `/health/live` showed 3 to 5 failures per update
that were the probe, not lost traffic.
