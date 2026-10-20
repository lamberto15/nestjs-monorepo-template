# Blue-green deploys

Two copies of the API ("colours", blue and green) run side by side on the
host. One is live, behind Caddy. A deploy starts the other one on the new
image, tests it away from the traffic, and then moves the traffic over in one
step. The old colour keeps running for a while, so going back is the same
step in reverse: it takes seconds, with nothing to rebuild or restart.

```bash
pnpm deploy:blue-green status
pnpm deploy:blue-green deploy --image ghcr.io/<owner>/<repo>:<sha>
pnpm deploy:blue-green rollback
```

## Blue-green or rolling

| | Rolling (`docker compose up -d`, the default) | Blue-green |
| --- | --- | --- |
| Rollback | redeploy the old image: minutes | `rollback`: seconds, the old colour is still running |
| Test before traffic | health check only | a smoke check on the new colour while it takes no traffic |
| Resources during a deploy | one replica more at most | 2 × the API (both colours) |
| Moving parts | none | `compose.blue-green.yaml` and a script |

Choose blue-green when a bad release must be undone at once, or when the
release should be tested against the real database before it serves anyone.
Stay with rolling when the host has no room for a second set of API replicas.

## Prerequisites

Both colours run at the same time, on the same PostgreSQL, Redis and queues,
so each release must work next to the one before it:

- **Expand-only migrations.** The migrations run once, before the new colour
  starts, while the old colour still serves. A release's migrations add
  (columns, tables) and never drop, rename or retype: expand/contract
  ([pitfalls](pitfalls.md), "Migrations: expand/contract"; CI's
  `migration-lint` checks it). The contract step ships in a later release,
  after the old colour is gone for good. Rolling back relies on the same rule:
  the old image runs on the new schema.
- **Jobs that both versions understand.** There is one worker set (below), and
  both colours add jobs, outbox events and workflow steps to the same queues.
  A job a release adds, or a payload it changes, is handled by the worker of
  the release before it and the one after it: add the field first, read it
  one release later; never rename a job.
- **Sessions and cookies** are shared through PostgreSQL and Redis, so a user
  stays signed in across a switch. A realtime (socket.io) connection is cut
  at the switch and reconnects to the new colour.

## Setup

Add the override file to `COMPOSE_FILE` in `.env`:

```bash
COMPOSE_FILE=compose.yaml:compose.prod.yaml:compose.blue-green.yaml
```

It replaces the single `api` service with `api-blue` and `api-green` (both
`API_REPLICAS` replicas, the same limits and settings), and puts Caddy on a
network of its own, `edge`. `caddy/Caddyfile` stays as it is.

Starting from a running rolling stack, take `api` down first (`docker compose
stop api`); the first `deploy` starts blue, and the site is down in between.
After that, deploys never are.

Do not `docker compose up -d` the colours yourself: the script passes each
one its image and its network alias, and a plain `up` would put the default
image back. `docker compose up -d` for everything else (PostgreSQL, Redis,
Caddy, backup) is fine.

## How the traffic moves

Caddy finds the API by resolving the name `api` through Docker's DNS every
five seconds (`dynamic a` in the Caddyfile). Caddy is on the `edge` network
only, and only the live colour's containers answer to `api` there:

```text
edge network      caddy ──resolves "api"──▶  blue (alias api)      live
                                              green (alias api-green) idle, unseen
default network   blue, green, worker ──▶ PostgreSQL, Redis
                  the idle colour answers to api-green here: the smoke check
```

A switch moves the alias with `docker network connect --alias`, in two steps:

1. The new colour's containers join `edge` with the alias `api`. For a moment
   `api` lists both colours, and Caddy shares the requests between them.
2. After `--settle` seconds (default 7, longer than Caddy's five-second
   refresh, so Caddy has certainly learned the new addresses), the old
   colour's containers leave `api`.

So `api` is never empty and Caddy never holds only addresses that are gone.
The cookie policy (`lb_policy cookie lb_replica`) falls over by itself: a
cookie naming a container that left the pool is ignored, and Caddy picks one
and sets a new cookie. A container's database and Redis connections are on
the default network and are not touched.

The idle colour is not reachable from outside at all. The script tests it from
inside: in every replica, `http://127.0.0.1:3000<path>`, and by its name
(`http://api-green:3000<path>`) over the default network.

## Commands

All of them read the live colour from Docker (which colour's containers have
the `api` alias on `edge`) and the images from the containers: no state file.

```bash
pnpm deploy:blue-green status [--json]
```

The live colour, and per colour its containers, health and image.

```bash
pnpm deploy:blue-green deploy --image ghcr.io/<owner>/<repo>:<sha>   # a published image
pnpm deploy:blue-green deploy --build                                # from this checkout
```

In order: start PostgreSQL, Redis and Caddy if they are not running; pull
(or build) the image; run the migrations with it (`migrate`, once; skip with
`--no-migrate`); start the idle colour on it; wait until every replica is
healthy (`--timeout`, 180 s); smoke check; switch; move the worker to the new
image (`--no-worker` leaves it); wait the grace period, then stop the old
colour.

A deploy stops at the first failure, and the live colour never changes before
the smoke check passed. A failed new colour stays up for you to read its logs
(`docker compose logs api-green`); the next `deploy` recreates it.

| Option | Default | |
| --- | --- | --- |
| `--grace <seconds>` | 300 | How long the old colour keeps running. `0` stops it at once; `keep` leaves it until `finish`. The script waits that long: run it in the background (or use `keep`) for a long grace. If you rolled back meanwhile, the colour that is live again is not stopped |
| `--smoke-path <path>` | `/health` | Checked (2xx) in every replica; repeat it for more paths |
| `--settle <seconds>` | 7 | Between the new colour taking `api` and the old one leaving it |
| `--timeout <seconds>` | 180 | Waiting for the idle colour's replicas to be healthy |
| `--to blue\|green` | the other colour | `switch` only: the colour to make live |
| `-p`, `-f`, `--env-file` | | As `docker compose` |

```bash
pnpm deploy:blue-green switch      # to the other colour
pnpm deploy:blue-green rollback    # the same
pnpm deploy:blue-green finish      # stop the idle colour now
```

`switch` (or `rollback`) makes the other colour live. If its containers are
stopped (after the grace period), it starts them first, on the image they had,
waits until they are healthy and smoke checks them, then flips. Before the
grace period is over nothing starts: the flip alone is the rollback. The
worker moves to that colour's image too (`--no-worker` leaves it). The colour
that was live keeps running; `finish` stops it.

`rollback` returns to the previous image, not to the previous schema:
migrations are never undone.

## The worker

One worker set serves both colours. A worker per colour would have the
queues' jobs go to either, depending on who picks them up, and a job added by
the new colour could land on the old worker anyway; so the compatibility rule
above is needed in any case, and one set is simpler and cheaper. The worker
follows the live colour's image: `deploy` and `switch` recreate it after the
flip (graceful: a running job finishes, or is handed back, within the
60-second stop period). `--no-worker` keeps it on its current image, for a
release whose worker you want to move separately.

## Limits on one host

- **Twice the API during a deploy.** Both colours run, so the host needs
  `2 × API_REPLICAS × (API_CPUS, API_MEMORY)` besides the worker, PostgreSQL
  and the rest. After the grace period the old colour is stopped, but its
  containers remain (stopped), which is what `switch` starts again.
- **Database connections**: `2 × API_REPLICAS × API_DATABASE_POOL_MAX` plus the
  workers' must stay below `POSTGRES_MAX_CONNECTIONS − 10`
  ([deployment](deployment.md), "Resource limits"). Lower `API_REPLICAS` or
  the pool, or raise the maximum, before the first blue-green deploy.
- **A single host.** The switch is Docker networking; more hosts take an
  orchestrator that does this natively.
- **Monitoring** that scrapes `api:3000` must scrape `api-blue:3000` and
  `api-green:3000` instead (the live one answers; the idle one is also up).
- **Caddy's connections to the old colour** are cut when it leaves `api`. A
  request in flight at that instant can fail; the measured switches below
  lost none (requests are short), but a very long request (an export
  download) could. Leave a quiet moment for those.

## Measured

On a throwaway Compose project (two API replicas per colour, Caddy with the
Caddyfile's `reverse_proxy` block, eight clients sending about 130 requests a
second to `/health` through Caddy, no cookies):

| Run | Requests | Errors | Traffic moved |
| --- | --- | --- | --- |
| `deploy` (v1 live, v2 to green, old stopped after a 20 s grace) | 18,404 | 0 | the new colour took its first request within Caddy's 5 s refresh of the flip beginning, the old its last at the end of the 7.4 s flip; none after |
| `rollback` to a colour stopped after its grace (start, healthy, smoke, flip) | 12,638 (with the next run) | 0 | the command took 24 s: starting and checking the colour, the 7.9 s flip, restarting the worker |
| `rollback` with both colours running | the same run | 0 | the flip alone: 7.4 s, the new colour serving within 5 s of its start |

A client holding the cookie of a replica of the old colour went on getting
200 and was moved to a replica of the new one.

The 7 s is `--settle`: the window in which Caddy learns the new addresses
before the old ones go away. Nothing waits on it but the script: the new
colour already serves from the first refresh (at most 5 s). Shorten it to
Caddy's `refresh` plus a second at the risk of errors if Caddy's refresh is
slow; lengthen it if the Caddyfile's `refresh` is.
