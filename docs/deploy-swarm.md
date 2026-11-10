# Docker Swarm

How our servers run: staging and production are single-node Docker Swarms,
deployed by GitHub Actions. Swarm gives rolling updates of `api` and `worker`
with no stopped capacity, an automatic rollback when a new version doesn't
become healthy, and the same configuration as the Compose deployment
([deployment.md](deployment.md)). One node or several.

This page covers the CI deploys, the one-time host setup, the configuration,
sizing and rollback, then how the stack is built.

## Environments and CI deploys

|                    | staging                                                                                                   | production                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GitHub environment | `staging`                                                                                                 | `production`                                                                                                         |
| Host               | the staging host                                                                                          | the production host (2 vCPU / 4 GB cloud server)                                                                     |
| Deploys            | every merge to `main` whose CI run published images, when the repository variable `AUTO_DEPLOY` is `true` | only by a manual **Deploy** run with a release tag                                                                   |
| Gate               | none                                                                                                      | the tag's GitHub release must be published and not a pre-release; the environment has the owner as required reviewer |

Both run the same committed sizing overlay ([Sizing](#sizing)) so staging
behaves like production.

**Images are built once.** CI / CD builds and signs the images on `main` and
records them in the `release-manifest-v1` artifact. A deploy never rebuilds:
`tools/ci/deploy-release.mjs` verifies the run's evidence, that the source
commit is an ancestor of `main`, and the cosign signature and attestation of
each image digest, then deploys by digest (`APP_IMAGE`, `CADDY_IMAGE`,
`BACKUP_IMAGE`; Gotenberg's is the official image `compose.prod.yaml` pins,
and a release from before that still passes its own `GOTENBERG_IMAGE`).

**The Deploy workflow** (`.github/workflows/deploy.yml`):

- Triggers: `workflow_run` (CI / CD completed on `main` with success, and
  `vars.AUTO_DEPLOY == 'true'`: deploys staging) and `workflow_dispatch` with
  the inputs `environment` (`staging` or `production`) and `tag` (empty on
  staging means the newest `main` build; required for production).
- A first job, with no environment and no secret but the workflow's token,
  picks the CI run and verifies it; production's reviewer is asked only for a
  run that passed. Production also needs a staging Deploy run after CI whose
  deploy job passed on the release's commit or a newer one: when staging
  failed, fix it (or re-run that staging run) before deploying production.
- The deploy job joins the tailnet with `tailscale/github-action` (OIDC, the
  environment's own tag `TS_TAG`, so a staging run can't reach the production
  host), writes the environment secret `DEPLOY_ENV_FILE` to a
  temporary file and runs `tools/deploy/swarm.mjs deploy` against the host
  over SSH (`DOCKER_HOST=ssh://deploy@$DEPLOY_HOST`,
  `SWARM_OVERLAYS=compose.small.yaml`).
- `swarm.mjs` migrates, rolls out and rolls back a failed update by itself
  ([Deploying](#deploying)). Then the job checks `$APP_URL/health`.
- Concurrency group `deploy-<environment>`; a running deploy is never
  cancelled.

**Settings** (GitHub, Settings, Secrets and variables):

| Where            | Name                                | Kind     | What                                                                                                                                                                           |
| ---------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| each environment | `DEPLOY_HOST`                       | variable | the host's tailnet name                                                                                                                                                        |
| each environment | `APP_URL`                           | variable | the public URL the health check calls                                                                                                                                          |
| each environment | `DEPLOY_ENV_FILE`                   | secret   | the `.env` ([Configuration](#configuration-deploy-env-file))                                                                                                                   |
| each environment | `TS_TAG`                            | variable | the tailnet tag its deploys join as (`tag:github-staging-deploy`, `tag:github-prod-deploy`)                                                                                    |
| each environment | `SWARM_OVERLAYS`                    | variable | the Compose files on top of the stack: `compose.small.yaml` (the default), production adds `compose.tunnel.yaml` ([Public access](#public-access-through-a-cloudflare-tunnel)) |
| each environment | `TS_OAUTH_CLIENT_ID`, `TS_AUDIENCE` | secrets  | its own Tailscale trust credential, that tag only; its subject is the job's OIDC `sub` (below)                                                                                 |
| repository       | `AUTO_DEPLOY`                       | variable | `true` turns on staging deploys from `main`                                                                                                                                    |

The trust credential's subject must be exactly the `sub` GitHub puts in the
job's token. With immutable subjects (GitHub's default for new repositories:
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` shows
`use_immutable_subject` and the prefix) it carries the owner's and the
repository's IDs, `repo:<owner>@<owner id>/<repo>@<repo id>:environment:<name>`,
which survive a rename or a transfer; otherwise `repo:<owner>/<repo>:environment:<name>`.
A mismatch fails "Join the deployment tailnet" with a 403 from Tailscale.

Our environments deploy only through Actions, never from a laptop.

## One-time host setup

On each host (staging and production), once:

1. Install Docker Engine (27 or newer) and Tailscale.
2. `docker swarm init --advertise-addr <tailnet IPv4>`
3. `docker node update --label-add stateful=true <node>`
4. `useradd --create-home deploy && usermod -aG docker deploy`
5. Tailscale: tag the host (`tag:staging-server`, `tag:production-server`),
   turn on Tailscale SSH (`tailscale set --ssh`), and let only that
   environment's deploy tag in, as `deploy`: a grant on `tcp:22` (and
   `tcp:443` for the health check on a tailnet-only host) plus an `ssh` rule
   with `"users": ["deploy"]`.
6. Point the DNS name in `APP_URL` at the host. Caddy gets its certificate
   by Cloudflare's DNS challenge, so a host reachable only on the tailnet
   gets one too; for public traffic, open 80, 443 and 443/udp.

Never run `docker swarm init` or `docker swarm leave` on a host where a plain
Compose stack is running (see the warning under [One node](#one-node)).

## Configuration (`DEPLOY_ENV_FILE`)

The environment secret `DEPLOY_ENV_FILE` is the `.env` that
`pnpm run setup --target production` produces ([configuration.md](configuration.md)).
Keep `NODE_ENV=production` on both environments; on staging set
`APP_ENV=staging`. The image variables are not in the file: the workflow pins
them by digest. To change a setting, edit the secret and run Deploy again.

Give secrets as values (`JWT_SECRET=…`), not as `*_FILE` paths: the file is
read on the GitHub runner, which has no files of the host, and Swarm stores
each value as an encrypted secret. Leave `COMPOSE_FILE` and `COMPOSE_PROFILES`
out (the workflow chooses the files; the heavy worker, ClamAV and monitoring
don't fit the sizing).

## Sizing

Staging and production use the same overlay, `compose.small.yaml`, made for a
2 vCPU / 4 GB host, so staging matches production. See the file for the
numbers.

| Service     | Replicas                    | CPU limit / reservation | Memory limit / reservation | Settings                                                           |
| ----------- | --------------------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------ |
| api         | 1 (2 while a deploy starts) | 1 / 0.25                | 512 MB / 384 MB            | heap 256 MB, 1 password hash at a time, pool 10                    |
| worker      | 1 (stop-first update)       | 1 / 0.25                | 512 MB / 384 MB            | heap 256 MB, pool 10                                               |
| postgres    | 1                           | 1 / 0.5                 | 1600 MB / 704 MB           | `max_connections` 50, `shared_buffers` 384 MB, `max_wal_size` 4 GB |
| redis       | 1                           | 0.25 / 0.1              | 160 MB / 128 MB            | `maxmemory` 112 MB                                                 |
| caddy       | 1                           | 0.25 / 0.1              | 128 MB / 64 MB             |                                                                    |
| gotenberg   | 1                           | 0.5 / 0.1               | 512 MB / 256 MB            |                                                                    |
| backup      | 1                           | 0.25 / 0.05             | 160 MB / 64 MB             |                                                                    |
| migrate     | a job, before the rollout   | 0.5                     | 384 MB                     |                                                                    |
| cloudflared | 1 (production only)         | 0.25 / 0.05             | 64 MB / 32 MB              | `compose.tunnel.yaml`                                              |

PostgreSQL's cap is mostly the kernel's cache of its files, which cgroups
charge to the container and the kernel reclaims under pressure: CI budgets it
by its reservation (shared buffers and connections). Too small a cap makes it
throw its cache away and read the disk again (it held 640 MB before v0.1.3).
The other memory limits are hard caps: about 2.6 GiB in steady state and 3.1 GiB while
a deploy runs the new api next to the old one, within what a 4 GB host leaves
after the OS, Docker and Tailscale. CPU limits add up to more than 2 on
purpose (CPU is shared, not reserved); the reservations add up to 1.4 CPU,
and 1.65 while a deploy reserves the new api's share next to the old one's
(Swarm leaves a task pending when its reservations don't fit). Only the api
starts first; the worker and Gotenberg stop first.
CI's `stack-config` job renders the overlay and fails if it outgrows the host.
One api replica means a single process serves requests: scale out by moving
to a bigger host (or more nodes) rather than squeezing a second replica in.

**Monitoring on this host.** `compose.monitoring.yaml` (Prometheus,
Alertmanager, the exporters, and Loki, Alloy and Grafana when their profiles
are on) does not fit in what a 4 GB host has left, so production runs
without it. Two ways to watch it anyway: run the monitoring stack on another
host (staging's spare capacity) and scrape production's `/metrics` over the
tailnet (the api's port 3000 must be reachable there: Caddy never proxies
`/metrics`; `METRICS_TOKEN` is the scrape's credential), or ship to a hosted
service (Grafana Cloud's free tier or similar) with Alloy alone on the
production host. Until one of those is set up, production has only the
API's `/health`: point an uptime service at it ([deployment](deployment.md),
"The outside probe").

## The heavy worker and the optional overlays

The deploy renders the stack with the profile `app` (api, worker, Caddy) and
nothing else of its own. What a bigger host adds:

- **Heavy worker** (`worker-heavy`, profile `heavy-worker`: [background
  work](background-work.md#splitting-the-workers)): set `HEAVY_QUEUES` (for
  example `data-transfers,documents,attachment-images,attachment-text`) in
  `DEPLOY_ENV_FILE`, or in the environment of a hand deploy. The script then
  adds the profile, and `worker` leaves those queues out. `HEAVY_WORKER_*`
  size it (`env.example`). It rolls like `worker`, start-first. Not part of
  `compose.small.yaml`: add memory to the host first.
- **Overlays** in `SWARM_OVERLAYS`, after `compose.small.yaml`:
  `compose.pgbouncer.yaml` (PgBouncer in front of PostgreSQL),
  `compose.pitr.yaml` (WAL archiving; its `wal-init` runs as a job on the
  stateful node, set up by `compose.swarm-pitr.yaml`, which the script adds
  after it) and `compose.clamav.yaml` (malware scanning). They need no
  profile. None of them is sized for the 2 vCPU / 4 GB hosts.

`COMPOSE_PROFILES` stays out of `DEPLOY_ENV_FILE`: the script ignores it.

## Public access through a Cloudflare Tunnel

Production is public without opening a port: `compose.tunnel.yaml` adds
`cloudflared`, which connects out to Cloudflare, so the host's firewall stays
closed (only Tailscale) and its address stays private. Cloudflare's edge
terminates the visitor's TLS and sends the request down the tunnel to Caddy,
which still holds its own certificate (the DNS challenge). Staging doesn't use
it: it stays on the tailnet.

Once, in Cloudflare Zero Trust (Networks, Tunnels):

1. Create a tunnel (Cloudflared) and copy its token into the environment's
   `DEPLOY_ENV_FILE` as `CLOUDFLARE_TUNNEL_TOKEN=…`. Skip the install
   commands Cloudflare shows: the stack runs `cloudflared`.
2. Add a public hostname: `APP_DOMAIN`, service **HTTPS** `caddy:443`, and
   under TLS, origin server name `APP_DOMAIN` (Caddy answers that name only).
   Cloudflare creates the DNS record (a proxied CNAME to the tunnel); delete
   any A record of that name first.
3. Set the environment variable `SWARM_OVERLAYS` to
   `compose.small.yaml,compose.tunnel.yaml` and deploy.

Behind the tunnel every request reaches Caddy from `cloudflared`. The overlay
makes Caddy trust the stack's private network and take the visitor's address
from `CF-Connecting-IP` (`CADDY_TRUSTED_PROXIES`, `CADDY_CLIENT_IP_HEADERS`),
and Caddy hands the API that one address as `X-Forwarded-For`; without the
overlay Caddy trusts nobody and sends the connection's own address. So rate
limits, audit entries and API clients' IP allowlists see the visitor, not the
tunnel.

Limits: tenants' custom domains (`CUSTOM_DOMAINS`) can't get certificates
(their HTTP-01 and TLS-ALPN-01 challenges never reach Caddy), and Cloudflare's
free plan refuses request bodies over 100 MB.

## Rolling back

Run Deploy with an older release tag (staging or production). That redeploys the older images by digest through the same checks and the
same rolling update. Migrations are expand/contract, so the older code runs on
the newer schema: a failed deploy rolls the services back, never the
database ([deployment.md](deployment.md), "Migrations"). During a deploy,
Swarm itself rolls a service back when its new tasks don't become healthy.

## Deploying by hand

For adopters without CI:

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

| Compose                               | Swarm                                                                                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build:`                              | Images are pulled: `APP_IMAGE`, `BACKUP_IMAGE`, `CADDY_IMAGE` are required (Gotenberg's is the official image `compose.prod.yaml` pins), pushed to a registry first (below). `--with-registry-auth` hands a private registry's login to the nodes. |
| `depends_on`                          | Ignored. A task that starts before PostgreSQL or Redis fails its healthcheck or exits, and `restart_policy` retries it.                                                                                                                            |
| one-shot `migrate`                    | A `replicated-job` service the script deploys and waits for before the app is touched.                                                                                                                                                             |
| bind mounts (`Caddyfile`, `redis.sh`) | Swarm configs.                                                                                                                                                                                                                                     |
| `restart:`                            | `deploy.restart_policy` (any, 5 s).                                                                                                                                                                                                                |
| `.env` secrets as files               | Swarm secrets, from the same files (`X_FILE` in `.env`).                                                                                                                                                                                           |

## Images

CI publishes the app, Gotenberg, Caddy and backup images to GHCR
([deployment.md](deployment.md), "CI"); `CADDY_IMAGE` is the published
`ghcr.io/<owner>/<repo>/caddy:<full commit SHA>` (Caddy with the Cloudflare DNS
module and the web app; nothing in it is one deployment's). Without CI, build
the backup image from `backup/` yourself and push it:

```bash
docker build -t ghcr.io/<owner>/<repo>/backup:1 backup && docker push ghcr.io/<owner>/<repo>/backup:1
```

For a hand deploy, `.env` (or the shell): `APP_IMAGE=ghcr.io/<owner>/<repo>:<full commit SHA>`,
`CADDY_IMAGE` (the same commit as `APP_IMAGE`: it holds the web
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

## Upgrading Caddy's runtime user

The non-root Caddy image runs as `10001:10001`. Before its first rollout on an
existing stack, migrate the certificate volumes on the **stateful node that owns
them**. New volumes inherit the image's ownership. The rendered service retains
`cap_drop: [ALL]` and its namespaced low-port sysctl; published ports stay 80/443.

1. Record the current Caddy image and take your normal certificate-volume backup.
2. On the manager, stop its only writer: `docker service scale <stack>_caddy=0`.
   Wait for the old task to stop before changing the volumes.
3. On the stateful node, verify the existing volume names with
   `docker volume inspect <stack>_caddy_data <stack>_caddy_config`, then run:

   ```bash
   docker run --rm --read-only --network none --user 0:0 \
     --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
     --mount type=volume,src=<stack>_caddy_data,dst=/data \
     --mount type=volume,src=<stack>_caddy_config,dst=/config \
     --entrypoint chown <new-caddy-image> -R 10001:10001 /data /config
   ```

   Substitute the actual stack name and new image reference. Do not use new or
   empty volumes: this command must operate on the existing certificate store.

4. Set the new `CADDY_IMAGE` and deploy with `pnpm deploy:swarm`; check its task,
   HTTPS, certificate reuse and configured `security.txt`.

For rollback, scale Caddy to zero and wait for the task to stop again, run the
same ownership command with `-R 0:0`, then deploy the recorded previous image.
Ownership changes preserve files and modes; they need a short Caddy maintenance
window. Do not delete certificate volumes or loosen private-key permissions.
See [the Compose procedure](deployment.md#upgrading-caddy-to-the-non-root-image)
for host-file secret permissions and the runtime hardening details.

## Limits of this setup

- The backup service's healthcheck is off: Swarm would kill an unhealthy
  container, and with it a running backup. Check it with
  `docker exec <container> backup-health`, or alert on the logs.
- `security_opt: no-new-privileges` (Gotenberg and every other service,
  [deployment.md](deployment.md), "Container hardening") has no Swarm
  equivalent and is dropped; the rest of the hardening (read-only, tmpfs,
  `cap_drop`/`cap_add`, Gotenberg's internal network) is kept. It needs
  Docker 27 or newer, whose services accept capabilities.
- `tmpfs:` is ignored by `docker stack deploy`, which would leave a
  read-only service with no writable `/tmp`: the script turns each entry
  into a `type: tmpfs` volume (tools/deploy/render.mjs). The size is kept;
  Gotenberg's `uid` and `gid` have no Swarm equivalent, so its home is
  writable by anyone.
- Secrets changes need the script (or `docker stack deploy`) to run again.
- The measurements below are from a one-node swarm on a laptop.

## Measured

On a one-node swarm (2 api replicas, 1 worker), three clients at about 9
requests a second to `GET /v1/account` without credentials (a real route:
401 expected) through Caddy, during each deploy:

| Deploy                               | Requests                      | Unexpected                                                                               |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| api image update, run 1              | 1251                          | 0                                                                                        |
| api image update, run 2              | 1251                          | 0                                                                                        |
| a version that never becomes healthy | 1289 (probing `/health/live`) | 0: one new task tried and failed, the old two kept serving; `rollback_completed`, exit 1 |
| Caddy update (new Caddyfile)         | 1212 (probing `/health/live`) | 13, about two seconds of refused connections                                             |

Probe a real route, not `/health` or `/health/live`: a draining replica
answers 503 on both by design while it still serves real requests, so an
earlier measurement with `/health/live` showed 3 to 5 failures per update
that were the probe, not lost traffic.
