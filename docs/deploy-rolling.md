# Rolling deploys

`pnpm deploy:rolling` replaces the running `api` and `worker` containers of the
Compose production stack with a new version without a request failing: the new
containers start next to the old ones, take over once they are healthy, and
only then do the old ones drain and stop. It is `tools/deploy/rolling.mjs`:
plain ESM, no tool to install, its tests (`node --test tools/deploy/rolling.test.mjs`)
run without Docker.

## What it does

1. **Builds** the images (`docker compose build`), or **pulls** them when
   `APP_IMAGE` is set (a published image: [deployment](deployment.md), "Publishing and rolling back images").
2. **Starts** PostgreSQL and Redis if they are not running (a no-op otherwise).
3. **Migrates**: `docker compose run --rm migrate`, while the old containers still serve.
4. For each service (`api`, then `worker`), with *n* containers running:
   1. `up -d --no-deps --no-recreate --scale <service>=2n`: *n* new containers next to the old ones;
   2. waits until every new one is `healthy` (the image's `/health/live` check, probed every 10 s, every 2 s while starting);
   3. waits `--settle` seconds (10): Caddy re-reads the replicas' DNS every 5 s
      and health-checks them every 5 s (`caddy/Caddyfile`), so the new ones are routed before the old ones go;
   4. `docker stop` + `docker rm` on the **old containers by id** (a scale-down
      would remove the highest numbers, which are the new ones). Back to *n*.

A new container that exits, turns `unhealthy` or isn't healthy after
`--health-timeout` seconds (120) **aborts the deploy**: the new containers are
removed and the old ones were never touched. The exit code is 1.

```bash
pnpm deploy:rolling                          # build, migrate, roll api and worker
pnpm deploy:rolling --services api           # only the api
pnpm deploy:rolling --skip-build --skip-migrate
pnpm deploy:rolling --health-timeout 180 --settle 15
pnpm deploy:rolling -p myproject --env-file /path/to/.env -f compose.yaml -f compose.prod.yaml
```

`-p`, `-f` and `--env-file` are Compose's; without them the command reads the
root `.env` (which sets `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`) like every
other `docker compose` command in these docs.

## Prerequisites

- **Expand/contract migrations.** The old version keeps serving on the new
  schema, and the new one starts before the old is gone. A migration that
  drops or renames what the running release uses breaks the old containers
  mid-deploy: split it over two releases ([development](development.md),
  "Expand/contract"; CI's `migration-lint` flags the unsafe ones). `migrate`
  runs *before* the new containers, so only expand steps may ship together
  with code.
- **Graceful shutdown** (below), so stopping an old container loses nothing.
- **Pinned images**: with `APP_IMAGE=ghcr.io/<owner>/<repo>:<sha>` the deploy
  pulls exactly that image, never `:latest`.
- **Two copies fit**: during the roll the stack runs 2n `api` containers
  (and two workers) at once. Check the memory limits and the connection
  budget: `API_REPLICAS × API_DATABASE_POOL_MAX` doubles for a few seconds
  and must stay below `POSTGRES_MAX_CONNECTIONS` ([deployment](deployment.md), "Resource limits").
- **A reverse proxy that discovers replicas** (Caddy's `dynamic a`, as shipped).
  A proxy with a fixed upstream list needs its own switch-over.

## Graceful shutdown

`docker stop` sends SIGTERM; `enableShutdownHooks()` (`apps/api/src/main.ts`) does the rest:

1. `/health` (readiness) and `/health/live` answer **503** at once (Terminus).
   It waits `gracefulShutdownTimeoutMs` (5 s) so that load balancers see the
   503 and stop routing; requests that still arrive are served.
2. The HTTP server **stops listening** (new connections are refused), the
   requests in flight **finish**, and keep-alive connections are **closed as
   they go idle** (`main.ts` sweeps them: Node's `server.close()` only
   closes the ones idle at that moment).
3. Queue workers, the outbox relay, webhook deliveries and workflow steps
   finish what they run or hand it back to the queue (BullMQ: unfinished jobs
   are returned to Redis and picked up by the next worker); connections to
   PostgreSQL and Redis close.
4. A deadline (25 s for `api`, 55 s for the worker) exits with code 1 when the
   shutdown hangs. `stop_grace_period` (`compose.prod.yaml`: 30 s `api`, 60 s
   `worker`) is longer, so Docker never has to SIGKILL a healthy shutdown. A
   request needing more than about 20 s after the SIGTERM is cut: keep
   requests short and put slow work on a queue.

## Proof

Both measured on a throwaway Compose project (`-p zdt-test`, the production
files, Caddy with the shipped `dynamic a` block on another port):

- **Drain** (`node tools/deploy/drain-check.mjs <api container>`; kills that
  container, so run it on a spare replica): a request left in flight (its body
  still arriving) while SIGTERM is sent. Observed: `/health` 200, then 503
  for the 5 s drain, then `ECONNREFUSED`; the request in flight, finished 7 s
  after the SIGTERM, answered normally; the container exited 0 right after.
- **Rolling deploy under load**: 4 keep-alive clients, 9 requests a second
  (the default rate limit is 600 a minute per IP: a heavier load only tests
  the limiter) on `GET /v1/account` through Caddy for 100 s, while
  `pnpm deploy:rolling` ran: **876 requests, 876 as expected (401), 0 errors,
  0 non-expected statuses** across the migrate step, `api` 2 to 4 to 2 and the worker.
- **Abort**: with a new image that cannot start (`API_HEAP_MB=bogus`), the
  deploy exited 1 (`new container ... is unhealthy; removed the new ones, the
  old keep serving`), and the old containers kept answering.

Health endpoints are the exception: a draining replica answers 503 on
`/health` **and** `/health/live` (Terminus), so do not use them as the probe
of a load test, and Caddy's own `/health` check takes up to 5 s to notice. Real
routes are served until the server stops listening.

## Rolling back

Deploy the previous image: set `APP_IMAGE` to its tag (or check out the
previous commit when building locally) and run `pnpm deploy:rolling` again. A
migration is not undone: that is what expand/contract is for, the previous
release runs on the expanded schema.

## Limits

- One host. Compose has no scheduler: this is a rolling restart on one
  Docker engine, not a multi-node orchestrator.
- `socket.io` clients connected to an old replica reconnect (to a new one).
  Realtime connections are not drained, only closed at the end.
- The worker overlaps with its successor for a few seconds: jobs, cron
  schedules and the outbox relay are safe with several workers (as with
  `WORKER_REPLICAS > 1`), but a job needing minutes is handed back, not
  waited for.
- A plain `docker compose up -d --build` still recreates the containers
  in place and drops requests for a moment: use this command for production.
- `migrate` is not rolled back when a later step fails; it is expand-only, so
  the old containers keep working.
