# Deployment

## Production with Docker Compose

```bash
pnpm setup --target production          # asks, writes .env (chmod 600), every secret generated
# or by hand:
cp env.example .env && chmod 600 .env   # then fill it (below)
docker compose up -d --build      # .env sets COMPOSE_FILE=compose.yaml:compose.prod.yaml
docker compose ps
```

Filling `.env` (each step is commented in `env.example`):

- **Required:** `APP_DOMAIN` and `ACME_EMAIL` (Compose stops without them),
  `CLOUDFLARE_API_TOKEN` (Caddy stops without it), `POSTGRES_PASSWORD` and
  `POSTGRES_APP_PASSWORD` (`openssl rand -hex 24` each: hex, since they go
  into `DATABASE_OWNER_URL` and `DATABASE_URL`; without them, `migrate` stops
  on the missing URL; the two roles: [Database roles](#database-roles)). The
  secrets can be files instead: [Secrets in files](#secrets-in-files).
- **Recommended:** `REDIS_PASSWORD` (`openssl rand -hex 24`) and
  `WEBHOOKS_ENCRYPTION_KEYS` (`openssl rand -base64 32`; unset, webhook
  endpoint secrets are stored unencrypted), and `BACKUP_S3_*` (unset, the
  backups stay on this host: [Backups and restore](#backups-and-restore)).
- **Required:** `MFA_ENCRYPTION_KEYS` (the app refuses to start without it, unless an
  older deployment still holds it in `app_secrets`: move it to the environment).
- **Required once a column is encrypted** (an SSO connection's client secret is;
  so are push tokens and phone numbers): `DATA_ENCRYPTION_KEYS` and
  `BLIND_INDEX_KEYS` (`openssl rand -base64 32` each; the app never creates them
  and refuses to start without them: [encryption](encryption.md)).
- **Optional:** `JWT_SECRET`, `STORAGE_SIGNING_KEYS`,
  `IDEMPOTENCY_KEYS`, `CURSOR_KEYS` and `EXAMPLE_SENDER_WEBHOOK_SECRET`: unset, the app
  creates each on the first start and keeps it in the database
  ([configuration](configuration.md)). `ADMIN_PASSWORD`: unset, the first
  administrator's password is logged once.
- **Caddy serves the web app too.** Its image builds `apps/web` (stage `web` of
  `caddy/Dockerfile`, context the repository root) into `/srv/web`. The Caddyfile sends
  `/v1/*`, `/socket.io/*`, `/health*`, `/api*` (Swagger UI), `/files*` and
  `/.well-known/*` to the API, `/metrics*` to a 404, and every other path to the app
  (`index.html` for its routes; `/assets/*` cached for a year, `index.html` never). The
  API's routes are the app's origin, so `__Host-sid` works and no CORS is needed. A new
  unversioned API path needs a line in the `@api` matcher. A web change redeploys Caddy
  (`docker compose up -d --build`).
- **The web app's security headers** are set in the Caddyfile's web-app `handle` only
  (the API's responses keep helmet's own): `Content-Security-Policy`
  (`default-src 'self'`; scripts and frames also from `https://challenges.cloudflare.com`,
  Turnstile's only needs; `connect-src 'self'` covers the API and socket.io;
  `img-src 'self' data:`; `style-src` keeps `'unsafe-inline'` because sonner and the theme
  provider inject `<style>` elements; no `'unsafe-eval'`, so `apps/web` imports `z` from `@/lib/zod`, which sets zod to
  `jitless`; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options`,
  `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` that turns
  off everything but WebAuthn. **A new third-party script, frame, API or font host** needs
  its origin in the matching directive of that one line (`script-src`, `frame-src`,
  `connect-src`, `font-src`, `img-src`), taken from the provider's CSP page; no inline
  `<script>`, no `eval`. Check a change by loading the built app through Caddy (`docker
build -f caddy/Dockerfile .`) in a browser and listening for `securitypolicyviolation`
  events: there must be none.
- **Security contact** (`/.well-known/security.txt`, RFC 9116). Caddy answers that one
  path itself (its handle comes before the `@api` matcher); `caddy/entrypoint.sh` writes
  the file to `/srv/security` at each start from `SECURITY_CONTACT` (one or more
  `mailto:`/`https:` URIs, comma-separated; the RFC requires it, and unset means no file,
  a 404), `SECURITY_EXPIRES` (RFC 3339 UTC; unset, a year from the start, so pin it to
  keep one date), `SECURITY_POLICY` (the `SECURITY.md` URL; the default is this template's
  on GitHub, so set your own) and `SECURITY_PREFERRED_LANGUAGES` (`en`). Check it after a
  deploy: `curl -i https://<APP_DOMAIN>/.well-known/security.txt`.
- **Replacing an earlier deployment's Caddy?** Its token and email:
  `docker inspect --format '{{json .Config.Env}}' <caddy container>`.

| Service     | What                                                                                                                           | Scale                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `caddy`     | HTTPS (Let's Encrypt via Cloudflare DNS), load-balances the API, serves the web app's files                                    | 1                     |
| `api`       | `node dist/main`, `APP_ROLE=api`                                                                                               | `API_REPLICAS` (2)    |
| `worker`    | `node dist/worker`, `APP_ROLE=worker`                                                                                          | `WORKER_REPLICAS` (1) |
| `migrate`   | `node dist/migrate`, once per deploy, before api and worker: the migrations as the owner, then the app role                    | one-off               |
| `postgres`  | PostgreSQL 18                                                                                                                  | 1                     |
| `redis`     | Redis 8 (append-only, `noeviction`); the app needs 7.0 or newer ([below](#redis))                                              | 1                     |
| `backup`    | `pg_dump` and the uploaded files on a schedule, copied off the host ([below](#backups-and-restore))                            | 1                     |
| `gotenberg` | HTML to PDF (Chromium) for the workers' documents, on a network of its own with no way out ([below](#gotenberg-pdf-documents)) | 1                     |

- **Resource limits** on every service (`API_CPUS`, `API_MEMORY`,
  `WORKER_CPUS`, `WORKER_MEMORY`, `POSTGRES_*`, `REDIS_*`, `BACKUP_*`,
  `GOTENBERG_*`): none can starve the
  others. The Node heap (`API_HEAP_MB`, `WORKER_HEAP_MB`) and Redis'
  `maxmemory` stay below their limits. Limits don't add capacity: keep their
  sum within the host's. See [Resource limits](#resource-limits) for how
  the app's are sized.
- The API is reachable only through Caddy (port 3000 isn't published): the
  Secure cookie and `trust proxy` rely on that.
- Local file storage is a volume shared by the replicas of one host. More hosts:
  `STORAGE_DRIVER=s3`.
- Logs are JSON on stdout (`docker compose logs`). `X-Request-Id` follows a
  request through Caddy, the logs and NestJS Observe. Credentials are
  masked before a line is written ([Log redaction](#log-redaction)).
- **Bounded logs:** each container keeps at most `DOCKER_LOG_MAX_FILE` (5)
  files of `DOCKER_LOG_MAX_SIZE` (20m), the older ones compressed, the
  oldest dropped. The driver is `local` (`DOCKER_LOG_DRIVER`), the one Docker
  recommends: compact, and `docker compose logs` reads it. Use `json-file`
  only for a log shipper that reads the files under
  `/var/lib/docker/containers`; shippers reading Docker's API work with
  both. A change applies when `up -d` recreates the containers (the first
  deploy with these settings recreates all of them, PostgreSQL and Redis
  included: a few seconds' pause). Older logs are not kept: ship them
  somewhere if you need them for longer.

### Zero-downtime deploys: three ways

Each keeps the old version serving until the new one is healthy, and every one
needs the same three things: expand/contract migrations (old and new code run
against the same database), graceful shutdown (in place: a replica finishes
its requests and exits), and pinned images (`APP_IMAGE` by commit SHA, so a
rollback is one command).

| Method               | Command                  | Rollback                                                             | Choose it when                                                                                                                           |
| -------------------- | ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Rolling (Compose)    | `pnpm deploy:rolling`    | deploy the previous `APP_IMAGE`                                      | one host, the default: new replicas start beside the old, which stop once the new are healthy ([deploy-rolling.md](deploy-rolling.md))   |
| Blue-green (Compose) | `pnpm deploy:blue-green` | `pnpm deploy:blue-green rollback`: instant while the old colour runs | one host, an instant switch back matters, 2× the API's resources during a deploy are fine ([deploy-blue-green.md](deploy-blue-green.md)) |
| Docker Swarm         | `pnpm deploy:swarm`      | automatic on a failed health check, or `pnpm deploy:swarm rollback`  | one or more nodes, updates and rollback by the orchestrator ([deploy-swarm.md](deploy-swarm.md))                                         |
| Kubernetes (Helm)    | `helm upgrade --install` | `helm rollback`; the migrate Job is a pre-upgrade hook               | a managed cluster ([deploy-kubernetes.md](deploy-kubernetes.md))                                                                         |

A plain `docker compose up -d --build` is not one of them: it recreates the
replicas in place (below, what Caddy does about that).

### Redeploying without downtime

`docker compose up -d --build` recreates both `api` replicas at once, and a
replica answers only after it boots (the image's health check starts after
30 s; Node needs 30-60 s with the migrations done). Compose has no rolling
update, so for that window no replica is up. What the stack does about it:

- **Caddy holds the request** (`lb_try_duration 30s`, `lb_try_interval 250ms`
  in `caddy/Caddyfile`, and the load test's copy): with no healthy upstream
  it tries again every 250 ms for up to 30 s instead of answering 503. A
  browser pinned (cookie `lb_replica`) to a replica that is gone is moved to
  a live one at the next try, and gets a new cookie. Replicas come and go
  through DNS (`dynamic a`, refreshed every 5 s), so a new one is found
  within 5 s of existing. There is no `lb_retries`: a count would end the
  tries before the duration does.
- **Limits:** a boot longer than 30 s still ends in a 503 for requests that
  waited. A request that reached a replica which then died is retried only if
  it is a GET (`lb_retry_match`); a failed connection is retried for any
  method. Open socket.io connections drop and reconnect (the client does).
  Active health checks (`health_uri`) run on static upstreams only; with
  `dynamic a`, a replica that refuses connections is skipped by the passive
  check (`fail_duration`) and the retries.

To shorten the window, have the images ready and the one-off steps done
before the replicas restart:

```bash
docker compose build api worker                # no downtime: the slow part
docker compose up -d --no-deps --wait migrate worker   # migrations, then the worker
docker compose up -d --no-deps --wait api      # recreates the replicas; Caddy holds requests
```

`--wait` returns when the replicas are healthy (the first check runs after
the image's 30 s start period, so it can take up to a minute). Migrations run
while the old replicas still serve, so a migration must stay compatible with
the old code (add a column before the code that uses it, drop it in a later
deploy). A real rolling update (one replica at a time, the other serving)
needs an orchestrator ([Scaling further](#scaling-further)); `--scale api=4
--no-recreate` followed by `--scale api=2` does not give it, because Compose
removes replicas by number, not by age.

### Secrets in files

The secrets below can live in files instead of `.env`. Compose mounts each
one as a Docker secret: a read-only file at `/run/secrets/<name>`, in no
variable and not in `docker inspect`. The container reads it. Each one is
optional: an `.env` holding the values themselves keeps working. A secret
without its `_FILE` is mounted from the empty `secret.empty`, which nothing
reads.

| `.env`                                                                                                                                                                                                                                                                                                                                                                                        | Read by                                                                                                                                               | Instead of                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `POSTGRES_PASSWORD_FILE`                                                                                                                                                                                                                                                                                                                                                                      | PostgreSQL (the image itself, when it creates the database), the backup (`backup/lib.sh`)                                                             | `POSTGRES_PASSWORD`                                 |
| `POSTGRES_MONITOR_PASSWORD_FILE`                                                                                                                                                                                                                                                                                                                                                              | `migrate` (creates the monitoring role with it) and the PostgreSQL exporter (`compose.monitoring.yaml`): one file                                     | `POSTGRES_MONITOR_PASSWORD`                         |
| `DATABASE_OWNER_URL_FILE`                                                                                                                                                                                                                                                                                                                                                                     | `migrate` only (the owner's URL with that password: `postgres://app:<password>@postgres:5432/app`); the secret is mounted on no other service         | the URL Compose builds from `POSTGRES_PASSWORD`     |
| `DATABASE_URL_FILE`                                                                                                                                                                                                                                                                                                                                                                           | the app (api, worker) and `migrate` (the app role's URL: `postgres://app_runtime:<password>@postgres:5432/app`, with `POSTGRES_APP_PASSWORD`'s value) | the URL Compose builds from `POSTGRES_APP_PASSWORD` |
| `REDIS_PASSWORD_FILE`                                                                                                                                                                                                                                                                                                                                                                         | Redis, its healthcheck and the Redis exporter (`redis/redis.sh`), and the app (`REDIS_PASSWORD`): one file                                            | `REDIS_PASSWORD`                                    |
| `DATABASE_MAINTENANCE_URL_FILE` | `migrate` (creates the role) and `worker` (the maintenance role's URL: `postgres://app_maintenance:<password>@postgres:5432/app`) | the URL Compose builds from `POSTGRES_MAINTENANCE_PASSWORD` |
| `POSTGRES_REPORTING_PASSWORD_FILE` | `migrate` only (creates the reporting role with it) | `POSTGRES_REPORTING_PASSWORD` |
| `CLOUDFLARE_API_TOKEN_FILE`                                                                                                                                                                                                                                                                                                                                                                   | Caddy (`caddy/entrypoint.sh`)                                                                                                                         | `CLOUDFLARE_API_TOKEN`                              |
| `BACKUP_S3_SECRET_ACCESS_KEY_FILE`                                                                                                                                                                                                                                                                                                                                                            | the backup                                                                                                                                            | `BACKUP_S3_SECRET_ACCESS_KEY`                       |
| `BACKUP_ENCRYPTION_KEY_FILE` | the backup (the age recipients, public keys, one per line) | `BACKUP_ENCRYPTION_KEY` |
| `SMTP_URL_FILE`                                                                                                                                                                                                                                                                                                                                                                               | the app, and Alertmanager (its default `ALERT_SMTP_URL`)                                                                                              | `SMTP_URL`                                          |
| `ANTHROPIC_API_KEY_FILE` | the app (api, worker; not `migrate`) | `ANTHROPIC_API_KEY` |
| `JWT_SECRET_FILE`, `MFA_ENCRYPTION_KEYS_FILE`, `STORAGE_SIGNING_KEYS_FILE`, `IDEMPOTENCY_KEYS_FILE`, `CURSOR_KEYS_FILE`, `WEBHOOKS_ENCRYPTION_KEYS_FILE`, `DATA_ENCRYPTION_KEYS_FILE`, `BLIND_INDEX_KEYS_FILE`, `ADMIN_PASSWORD_FILE`, `MAIL_API_KEY_FILE`, `AWS_SECRET_ACCESS_KEY_FILE`, `GOOGLE_CLIENT_SECRET_FILE`, `MICROSOFT_CLIENT_SECRET_FILE`, `GITHUB_CLIENT_SECRET_FILE`, `TURNSTILE_SECRET_KEY_FILE`, `OBSERVE_APP_SECRET_FILE`, `EXAMPLE_SENDER_WEBHOOK_SECRET_FILE` | the app (api, worker, migrate)                                                                                                                        | the variable without `_FILE`                        |

Not in this list, so they stay variables in Compose:

- `METRICS_TOKEN`: `compose.monitoring.yaml` gives Prometheus its secret from the variable.
- `AWS_SESSION_TOKEN`: a temporary credential, which a file mounted at deploy time can't renew.
- `OBSERVE_APP_KEY`.
- `POSTGRES_APP_PASSWORD`: it only builds `DATABASE_URL`, and the whole URL
  is the secret (`DATABASE_URL_FILE`); a file for the password alone would
  still have to be read into a URL by Compose, in a variable.
- The alerting stack's own `ALERT_*` URLs.

The app reads a `_FILE` for every secret (configuration.md, "Secrets"), so
outside Compose all of these work as files too.

In `.env`, `X_FILE` is the file's absolute path on the host. Compose hands
the containers `X_FILE=/run/secrets/x`.

- **The file or the variable, never both.** The app, Redis, Caddy, the
  backup, Alertmanager and PostgreSQL's image each refuse to start when both
  are set.
- **Trailing line breaks are dropped**, a CRLF too. The exception is
  `POSTGRES_PASSWORD_FILE`: write it with LF only, because PostgreSQL's image
  keeps a trailing `\r` as part of the password.
- **The Redis password never appears on a command line**, where `ps` and
  `docker top` would show it, whether it comes from a file or from the
  variable. The server reads it from stdin and `redis-cli` from
  `REDISCLI_AUTH`.
- **Caddy doesn't save its configuration** (`persist_config off`), so no copy
  of it ends up in the `caddy_config` volume.

**Moving a secret from `.env` to a file**, e.g. `JWT_SECRET`. Copy the value
the containers use now, never a new one: for the `*_KEYS` a new value locks
users out of their authenticator and makes stored data unreadable.

```bash
install -d -m 700 ~/secrets
umask 077
# What the app uses now: .env's value, else the one it created in app_secrets.
value=$(docker compose exec -T api printenv JWT_SECRET)
[ -n "$value" ] || value=$(docker compose exec -T postgres psql -U app -d app -Atc \
  "select value from app_secrets where name = 'JWT_SECRET'")
[ -n "$value" ] && printf '%s\n' "$value" > ~/secrets/jwt_secret
unset value
# Readable by the containers, which run as other users (node, postgres,
# nobody). Docker Desktop shows a 600 file as root's. The 700 directory keeps
# other users out.
chmod 644 ~/secrets/jwt_secret
# .env: empty the variable (JWT_SECRET=) and add JWT_SECRET_FILE=/home/<you>/secrets/jwt_secret
# A changed secret alone doesn't recreate a container: force it.
docker compose up -d --force-recreate api worker
```

The same applies to `DATABASE_URL` (`printenv DATABASE_URL` gives the URL
Compose builds now; `docker compose run --rm migrate printenv
DATABASE_OWNER_URL` the owner's) and to the other secrets.

- **The owner's password takes two files** holding the same password:
  `POSTGRES_PASSWORD_FILE` (PostgreSQL, the backup) and
  `DATABASE_OWNER_URL_FILE` (`migrate`). Then set `POSTGRES_PASSWORD=` empty
  and recreate `migrate backup`. **The monitoring role's** moves to
  `POSTGRES_MONITOR_PASSWORD_FILE` (`migrate` and `postgres-exporter`
  read the one file); set `POSTGRES_MONITOR_PASSWORD=` empty, recreate
  `migrate postgres-exporter`. PostgreSQL reads
  its file only when it creates a database: a running one already has its
  password.
- **The app role's password** moves to `DATABASE_URL_FILE` (the whole URL,
  `postgres://app_runtime:<password>@postgres:5432/app`). Then set
  `POSTGRES_APP_PASSWORD=` empty and recreate `migrate api worker`.
- **Redis' password** moves to `REDIS_PASSWORD_FILE`. Set `REDIS_PASSWORD=`
  empty, then recreate `redis api worker` (and `redis-exporter`).
- Rotation, per secret: [configuration](configuration.md#secrets).

**When something doesn't start.** Without `CLOUDFLARE_API_TOKEN`,
`POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD`, Compose itself no longer
stops, since each can be a file. What fails instead:

| `docker compose ps` / `logs`                                                                               | Cause                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate` exited 1: `DATABASE_OWNER_URL … and DATABASE_URL …, or their _FILE variants, are both required.` | neither `POSTGRES_PASSWORD`, `DATABASE_OWNER_URL` nor `DATABASE_OWNER_URL_FILE` in `.env`, or neither `POSTGRES_APP_PASSWORD`, `DATABASE_URL` nor `DATABASE_URL_FILE` |
| `migrate` or the app: `DATABASE_URL and DATABASE_URL_FILE are both set`                                    | `DATABASE_URL_FILE` while `POSTGRES_APP_PASSWORD` is still set: Compose builds `DATABASE_URL` from it. Empty `POSTGRES_APP_PASSWORD=`.                                |
| `migrate`: `DATABASE_OWNER_URL and DATABASE_OWNER_URL_FILE are both set`                                   | `DATABASE_OWNER_URL_FILE` while `POSTGRES_PASSWORD` is still set. Empty `POSTGRES_PASSWORD=` (and give PostgreSQL `POSTGRES_PASSWORD_FILE`).                          |
| `postgres` restarting: `superuser password is not specified`                                               | a new (empty) volume without either password                                                                                                                          |
| `caddy` restarting: `Set CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_TOKEN_FILE)`                              | neither in `.env`                                                                                                                                                     |
| `X_FILE: can't read /run/secrets/x (EACCES)`                                                               | the host file isn't readable by the container's user: `chmod 644`                                                                                                     |
| a warning `X_FILE is set, but X is not a secret read from a file`                                          | a misspelt `_FILE` variable: it is ignored                                                                                                                            |

**Deploying this change** recreates `postgres`, `redis` and `caddy` once,
even with no secret moved: their environment, secrets, command or image
change. That is a few seconds without the database, Redis and HTTPS, so
deploy in a quiet moment.

### Gotenberg (PDF documents)

The workers render [documents](documents.md) with
[Gotenberg](https://gotenberg.dev) (its Chromium-only image): a container of
its own, never Chromium in the worker's image, so a browser that runs out of
memory, or is attacked through a page, doesn't take the queues, workflows and
database credentials with it.

- **The image** (`gotenberg/Dockerfile`): the official
  `gotenberg/gotenberg:<version>-chromium`, pinned by version and digest,
  with its Debian packages upgraded and its two Go programs (gotenberg,
  pdfcpu) built again from the same release with a current Go and fixed
  `golang.org/x` modules, so CI's scan finds nothing fixable (job
  `gotenberg-image`). Fonts are the official image's: Noto for Latin, Arabic,
  Chinese, Japanese, Korean, and emoji.
- **Which image runs:** CI publishes the image it scanned, as it does the
  app's ([below](#publishing-and-rolling-back-images), job
  `publish-gotenberg`): `ghcr.io/<owner>/<repo>/gotenberg:<commit SHA>`,
  set as `GOTENBERG_IMAGE` next to `APP_IMAGE`. Each CI run upgrades the
  Debian packages afresh (`APT_REFRESH`), so a newer commit's image carries
  newer Chromium fixes. Unset, `docker compose up -d --build` builds it on
  the host, as a fallback: its Debian step is then cached after the first
  build, so rebuild it with `docker compose build --no-cache gotenberg` to
  pick up fixes.
- **The network:** `documents`, `internal: true`: no gateway, so nothing on
  it reaches the internet, the host or the other networks; no port is
  published. Only `worker` joins it (besides `default`); `api` never talks
  to Gotenberg (it only checks that `GOTENBERG_URL` is set).
- **What Chromium may load:** `--chromium-allow-list=^file:///tmp/` (the
  page Gotenberg writes; nothing else matches, the default deny list stays),
  `--chromium-deny-private-ips` and `--chromium-deny-public-ips` (every
  http(s) host refused, if the list ever allowed one),
  `--chromium-disable-javascript`, and at most 20 renders waiting
  (`--chromium-max-queue-size`: more answer 429, and the job retries
  later). Gotenberg's own outgoing calls are off:
  `--api-disable-download-from`, `--webhook-disable`. The templates add a
  Content-Security-Policy that allows inline styles and `data:` images and
  fonts only.
- **The container:** read-only, its `/tmp` (`GOTENBERG_TMP_SIZE`, 512m) and
  home in memory, no capabilities, `no-new-privileges`, healthy when
  `/health` answers. Limits: `GOTENBERG_CPUS` (1), `GOTENBERG_MEMORY` (1G,
  `/tmp` included). `--api-timeout=60s`, longer than the app's
  `GOTENBERG_TIMEOUT_MS` (30 s), after which the job tries again.
- **Off:** `GOTENBERG_URL=` (empty) in `.env` turns documents off (503
  `documents_unavailable`); leave the service out with it if you like
  (`docker compose up -d --scale gotenberg=0`). The app starts either way:
  nothing calls Gotenberg until a document is asked for.
- **Raising its version:** Dependabot proposes the `FROM` line;
  `GOTENBERG_VERSION` in the Dockerfile and `compose.dev.yaml`'s image
  follow it in the same pull request (`gotenberg-image` fails until they
  match, and while the two Compose files' flags differ).

### Resource limits

A Node process uses more than its heap, and the biggest part outside it is
password hashing: scrypt (N = 2^17, r = 8, p = 1, the OWASP minimum) takes
128·N·r bytes = **128 MiB per hash**, and ~0.4 s of one CPU, on the libuv
threadpool, which runs 4 at once. Before the limit, four concurrent sign-ins
took 512 MiB on top of the heap and the kernel killed the replica (exit 137)
at 5 sign-ins/s (the load test); every sign-in queued on it failed. So:

- **At most `PASSWORD_HASH_CONCURRENCY` hashes per process** (api 2,
  worker 1: `API_PASSWORD_HASH_CONCURRENCY`, `WORKER_PASSWORD_HASH_CONCURRENCY`),
  every hash and check of the app and of @nestjs/authentication included
  (`iam/account/password-hashing.ts`). The next ones wait in order, at most
  `PASSWORD_HASH_MAX_QUEUE` (20) of them for at most
  `PASSWORD_HASH_QUEUE_TIMEOUT_MS` (5000); the others get **503
  `server_busy`** with `Retry-After: 1` at once, never a pile of requests
  holding memory. The threadpool's other threads stay free for files and DNS.
- **The formula**, per container:

  ```text
  memory limit ≥ heap limit + 128 MiB + PASSWORD_HASH_CONCURRENCY × 128 MiB
  api:    768 MiB ≥ 384 (API_HEAP_MB)    + 128 + 2 × 128
  worker: 1 GiB   ≥ 768 (WORKER_HEAP_MB) + 128 + 1 × 128
  ```

  The 128 MiB in the middle is the rest outside the heap: the code, buffers
  and sockets (~50 MiB at idle), and MFA recovery codes (scrypt at 16 MiB
  each, inside the package, up to 4 at once). Change one term, change the
  others: a concurrency of 3 needs `API_MEMORY=896M`, a smaller limit a
  smaller `API_HEAP_MB` or concurrency.

- **Throughput**: each hash is ~0.4 s of CPU, so a replica checks about
  `API_CPUS` / 0.4 passwords per second (2.5 with one CPU) whatever the
  concurrency; more than `API_CPUS` hashes at once only share the CPU. More
  sign-ins per second need more replicas or CPUs (with their memory), never
  weaker hash parameters (`needsRehash()` would rehash every account, and
  the stored hashes keep their own parameters).
- **Watch it**: `password_hashes_in_flight`, `password_hashes_queued` and
  `password_hashes_rejected_total{reason="full|queue-timeout"}` on
  `/metrics`; the `PasswordHashingSaturated` alert fires after 10 minutes of
  refusals. `AppRestarting` catches a process still killed at its limit.
- **Images** ([attachments](attachments.md#image-renditions)): the worker
  converts one uploaded image at a time, with sharp (libvips), whose memory is
  outside the V8 heap and outside the formula above. A 48-megapixel JPEG that
  needs rotating kept the whole process near 140 MB resident, with no
  temporary file; the budget is about 4 bytes per pixel of
  `IMAGE_MAX_PIXELS` (50 million: 200 MB) on top of the file itself (at most
  64 MiB). The worker's 128 MiB "rest outside the heap" and the 768 MiB heap
  seldom peak together, and it hashes at most one password at a time, so the
  default limits hold; raise `WORKER_MEMORY` with `IMAGE_MAX_PIXELS`, and
  `/tmp` if libvips spills a very large image there (`Read-only file system`
  or `No space left` in the worker's log). A worker killed at its limit
  while converting leaves the image `pending`; the retry job queues it again.
  sharp brings libvips prebuilt (the `@img/sharp-*` package for the platform
  and libc, an optional dependency with no install script): the glibc image
  (`apps/api/Dockerfile`) needs no extra package and no `allowBuilds` entry.

### Container hardening

Every service of compose.prod.yaml runs with `read_only: true`,
`cap_drop: [ALL]` and `no-new-privileges`, and a `tmpfs` for what it writes
(Gotenberg's were the first). A compromised process then can't change the
image, plant a binary, or gain privileges. What each one may write, and the
capabilities it gets back:

| Service | Writable (besides the image: none) | Capabilities added back |
| --- | --- | --- |
| `api`, `worker`, `migrate` | `/tmp` (64m tmpfs); `api` and `worker` also the `app_storage` volume | none |
| `postgres` | the `postgres_data` volume, `/tmp` (64m) and `/run/postgresql` (the socket) in memory | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`: the image's entrypoint starts as root, fixes the data directory and drops to `postgres` |
| `redis` | the `redis_data` volume, `/tmp` (16m) | `DAC_OVERRIDE`: the command is `sh redis.sh`, not `redis-server`, so the image's entrypoint never drops to `redis`; the server runs as root on a volume that is `redis`'s, which root can't write without it |
| `caddy` | the `caddy_data` and `caddy_config` volumes, `/tmp` (16m) | `NET_BIND_SERVICE`: ports 80 and 443 |
| `backup` | the `backups` volume, `/tmp` (16m); `app_storage` stays read only | none (a files restore adds three: [Restoring](#restoring), step 4) |
| `gotenberg` | `/tmp` and its home, in memory (see above) | none |

- **The tmpfs counts against the container's memory limit** once used, so
  `/tmp` is small. Raise it in the service's `tmpfs:` line if a feature
  writes large temporary files (nothing in the app does today: exports and
  attachments go through the storage driver, and the image library works in
  memory at the default `IMAGE_MAX_PIXELS`).
- **Adding a service or a write path:** give the service the same keys, mount
  a volume or tmpfs on every path it writes, and start it with the stack up
  (`docker compose logs <service>`): a `Read-only file system` error names
  the path to add. Add a capability only when the service fails without it,
  and say why in a comment.
- **Not covered:** the optional `compose.monitoring.yaml` services, and
  `compose.yaml` / `compose.dev.yaml` alone (development), which keep the
  images' defaults.
- **Swarm** ([deploy-swarm.md](deploy-swarm.md)) renders these files, so it
  inherits `read_only` and the capabilities. `docker stack deploy` ignores a
  service's `tmpfs:` list, so `tools/deploy/render.mjs` turns each entry into
  a `type: tmpfs` volume (the size only: Gotenberg's `uid` and `gid` have no
  Swarm equivalent, the mount is writable by anyone). `security_opt` is
  dropped there.
- **CI** (`.github/workflows/ci.yml`): `compose-secrets` fails when a service
  of `compose.yaml` + `compose.prod.yaml` lacks the keys, whichever service
  it is; `hardened-stack` starts the stack on new volumes and fails when a
  container exits, restarts, is unhealthy or logs `Read-only file system`.
  Not started there: the production Caddy (its certificate needs a public
  name; the job runs the stock Caddy image on plain HTTP, with the
  `caddy_data` and `caddy_config` volumes `compose.loadtest.yaml` names: the
  stock image has no `VOLUME` there, so under `read_only` they would be
  read-only) and Gotenberg.

## Staging

The same stack and image, with its own `.env`: its domain, secrets, database,
`APP_ENV=staging` (names it in logs and traces), maybe `API_REPLICAS=1`.
**Keep `NODE_ENV=production`**: behaviour follows NODE_ENV, and staging must
run what production runs. Two stacks on one host can't both bind 80/443:
give staging its own host.

## Scaling further

Compose scales on one host. Beyond it:

- **Database:** a managed PostgreSQL 18 (`DATABASE_URL` for the app role,
  `DATABASE_OWNER_URL` for the admin account that owns the database:
  [Database roles](#database-roles)), with backups and point-in-time
  recovery; drop `postgres` and `backup` from the stack.
- **Read replicas:** not built in ([Read replicas](#read-replicas)).
- **Redis:** managed, or Sentinel (`REDIS_SENTINELS=host:26379,…`,
  `REDIS_SENTINEL_NAME`); drop `redis` from the stack.
- **Files:** S3 or R2 (`STORAGE_DRIVER=s3`, `S3_*`).
- **Hosts:** an orchestrator (Swarm, Kubernetes, a managed platform) runs the
  same image with the same three commands. socket.io across hosts needs
  `transports: ['websocket']` on clients, or sticky sessions.

### Read replicas

**The app has no read/write split: every query, lists and reports included,
goes to the primary** (`DATABASE_URL`). A `DATABASE_READ_URL` is not
implemented, on purpose, because the part that makes it sound is not small:

- Drizzle supports it (`withReplicas(primary, [replica])` from
  `drizzle-orm/pg-core`, reads to a replica, writes and `transaction()` to the
  primary), but the app's pool is `TenantPool` (`core/tenancy`), which sends the
  tenant's settings with every `begin`. A replica needs its own `TenantPool`
  (and the maintenance role's pool beside it), and the services run their
  queries through the transaction host (`database(this.txHost)`), so each one
  would have to be told, query by query, which pool it may read from.
- **Replication lag breaks read-your-writes:** a user creates a record, the
  list that follows reads a replica that has not seen it. Lists and reports
  would each need a decision: read the primary after a write by the same user,
  or accept the lag (a report, an export, an analytics aggregate usually can).
- Row-level security works on a replica (the policies replicate, and
  `set_config(…, true)` is allowed in a read-only transaction), so the tenant
  wall is not the obstacle.

**When you need it today:** a managed PostgreSQL's read replica, pointed at by
the scheduled reports and exports only (the heavy, lag-tolerant reads), is the
change to make: a second pool for the services behind them, with
`DATABASE_READ_URL` unset meaning the primary. Not built here because it needs a
replica to test against and a decision per query that only a real workload can
make. For more reads before that: PgBouncer ([above](#pgbouncer)), indexes
(`EXPLAIN` the slow list), a larger primary.

## Database roles

Two roles share the database ([roadmap](roadmap.md), 1a), so that row-level
security can mean something: PostgreSQL skips it for superusers and for a
table's owner, and the postgres image's `POSTGRES_USER` is both.

| Role            | Who                                                                             | Connects as                                                                                                                        | Gets                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **owner**       | `migrate`, `backup`; the app itself when `MIGRATE_ON_START` is on (development) | `DATABASE_OWNER_URL` (Compose: `POSTGRES_USER`, default `app`, the image's superuser)                                              | owns every schema, table and sequence; runs the migrations                                                                                                                                                                                                 |
| **app**         | `api`, `worker`                                                                 | `DATABASE_URL` (Compose: `POSTGRES_APP_USER`, default `app_runtime`, with `POSTGRES_APP_PASSWORD`)                                 | `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`; a member of no other role; owns nothing; `USAGE` on the schemas, `SELECT, INSERT, UPDATE, DELETE` on every table, `USAGE` on every sequence; never `CREATE`                                             |
| **maintenance** | `worker` (and `migrate`, which creates it)                                      | `DATABASE_MAINTENANCE_URL` (Compose: `POSTGRES_MAINTENANCE_USER`, default `app_maintenance`, with `POSTGRES_MAINTENANCE_PASSWORD`) | the app role's grants, and `BYPASSRLS`: the worker's sweeps across tenants and the metrics over every tenant ([tenancy](tenancy.md), "The bypass"); never on api                                                                                           |
| **monitor**     | the postgres-exporter (`compose.monitoring.yaml`)                               | `POSTGRES_MONITOR_USER` (default `app_monitor`) with `POSTGRES_MONITOR_PASSWORD`; managed PostgreSQL: `DATABASE_MONITOR_URL`       | the same flags as the app role (`NOBYPASSRLS`: no tenant's rows, nor any table's); a member of `pg_monitor` and of nothing else (`pg_stat_*`, the settings, sizes); owns nothing; no privilege on any table: statistics, never rows                        |
| **reporting**   | platform analytics: a BI tool, outside the stack                                | `POSTGRES_REPORTING_USER` (default `app_reporting`) with `POSTGRES_REPORTING_PASSWORD`                                             | the same flags as the app role; a member of nothing; owns nothing; `SELECT` on the `analytics` schema's tables (anonymized, suppressed aggregates) and no privilege on any other table: never a tenant's row ([tenancy](tenancy.md), "Platform analytics") |

`node dist/migrate` (`apps/api/src/core/database/roles.ts`) makes it so on
every deploy, after the migrations, as the owner: it creates the app role
from `DATABASE_URL`'s name and password when it is missing (a SCRAM verifier,
so the password never reaches the server's log), checks its attributes when
it exists (a role someone made a superuser is refused with the `ALTER ROLE`
that fixes it, never demoted silently), grants what the schema has, sets
`ALTER DEFAULT PRIVILEGES` so tables the owner creates later are covered,
verifies the result (a member of no other role, since `GRANT owner TO app`
would hand it the owner's rights with none of the flags set; owns nothing;
can create nothing, naming `REVOKE CREATE ON SCHEMA public FROM PUBLIC`
when a database made on PostgreSQL 14 or older still grants that; holds
all four DML privileges on every table and `USAGE` on every sequence)
before committing, and connects as the app once; a password that fails is
set from the URL (that is how `POSTGRES_APP_PASSWORD` rotates: change it,
redeploy). A second run finds nothing to do. It is code, not a migration
file: drizzle-kit can declare a role (`pgRole`) but emits no `GRANT` or
`ALTER DEFAULT PRIVILEGES`, and the role's name and password belong to the
deployment, not to the schema.

- **In Compose** the owner is the server's bootstrap superuser: the image
  creates exactly one role, a third would need its credentials somewhere
  anyway, and the owner never serves a request. Only `migrate` gets
  `DATABASE_OWNER_URL`; api and worker can't reach it.
- **The exception: `backup`** also connects as the owner: it reads every
  table and creates databases. It runs inside the Compose network and
  serves no request.
- **The monitoring role** (`ensureMonitorRole()`, the same file) exists
  only with the monitoring stack: `compose.monitoring.yaml` hands `migrate`
  `POSTGRES_MONITOR_PASSWORD` (or its `_FILE`, the same file the exporter
  reads) and `migrate` creates `POSTGRES_MONITOR_USER` with it, grants it
  `pg_monitor`, and verifies before committing that it is a member of
  nothing else (`pg_read_all_data`, the owner or the app role would hand it
  the rows), owns nothing, creates nothing and holds no privilege on any
  application table; a password that fails is set, as for the app role.
  Without the password, `migrate` says so and skips it (the exporter then
  can't connect: `PostgresDown`). `GRANT pg_monitor` needs the owner to
  hold `pg_monitor` with `ADMIN OPTION`: a superuser does; a managed
  admin may need `GRANT pg_monitor TO <owner> WITH ADMIN OPTION` once (or
  run the `GRANT pg_monitor TO app_monitor` the error names), and then
  sets `DATABASE_MONITOR_URL` for the exporter. Proof:
  `database-roles.e2e-spec.ts`, "the monitoring role".
- **The reporting role** (`ensureReportingRole()`, the same file) exists
  only when `POSTGRES_REPORTING_PASSWORD` (or its `_FILE`, mounted on
  `migrate` only) is set: `migrate` creates `POSTGRES_REPORTING_USER` with
  it, grants `USAGE` on the `analytics` schema and `SELECT` on its tables
  (and, through `ALTER DEFAULT PRIVILEGES`, on the ones the owner adds
  there later), and verifies before committing that it bypasses no
  row-level security, is a member of nothing, owns nothing, creates
  nothing, may not write the aggregates, holds no privilege on any table of
  another schema, and that no table of `analytics` has a `tenant_id` or
  `user_id` column. Without the password, `migrate` says so and skips it.
  What it reads: [tenancy](tenancy.md), "Platform analytics". Proof:
  `database-roles.e2e-spec.ts`, "the reporting role".
- **The schemas it is granted** are an explicit list: `public` (and any
  schema a table in `schema.ts` declares) plus the stores' `nest_outbox`,
  `nest_workflows` and `nest_webhooks`. Nothing else on the database: a
  managed PostgreSQL has schemas of the provider's or an extension's (`auth`,
  `storage`, PostGIS's `tiger`), which the app never touches and whose
  objects the ownership warning must not ask to reassign.
- **Managed PostgreSQL** gives no superuser: `DATABASE_OWNER_URL` is the
  admin account the provider made (it owns the database and has `CREATEROLE`,
  which since PostgreSQL 16 lets it alter the roles it creates), and
  `DATABASE_URL` names the app role you want, which `migrate` creates. If the
  owner may not grant `CONNECT` on the database (it isn't the database's
  owner), the app connects through `PUBLIC`'s default `CONNECT`; the log says
  so. Tables another role owns are reported with the `REASSIGN OWNED BY` that
  transfers them. The test suite runs this path on every CI run: its owner is
  a plain `CREATEROLE` role, not a superuser (`apps/api/test/global-setup.ts`).
- **Nothing creates or alters objects under the app's connection.** The
  outbox, workflow and webhook stores only check their schema version at
  startup (`migrate: false` in `platform.module.ts`); their migrations run
  through their CLIs in `node dist/migrate`. Secrets the app creates on first
  start (`app_secrets`) are plain rows. Advisory locks (`pg_advisory_xact_lock`)
  and `set_config(..., true)` need no privilege.
- **Proof, every CI run:** `apps/api/test/database-roles.e2e-spec.ts` connects
  as the app role and checks `pg_roles` (no superuser, no RLS bypass, no
  CREATEDB, no CREATEROLE), that it owns no relation, schema or database,
  that `CREATE TABLE`, `ALTER TABLE`, `DROP`, `CREATE INDEX`, `TRUNCATE`,
  `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, `CREATE ROLE`, `ALTER ROLE`,
  `CREATE DATABASE`, `CREATE EXTENSION` all fail with `42501`, and that rows,
  sequences, advisory locks and transaction-scoped settings work; and every
  other e2e test boots the app on that role. The `check` job runs `pnpm migrate`
  twice as a deploy does (a superuser owner, as in Compose).
- **The maintenance role** (`BYPASSRLS`) is made by the same run when
  `DATABASE_MAINTENANCE_URL` is set, with the app role's grants and checks (no
  superuser, owns nothing, a member of nothing). Only a superuser, or a role
  with `BYPASSRLS`, may create such a role: Compose's owner is the superuser;
  on a managed PostgreSQL whose admin account may not, create it once as one
  that may (`CREATE ROLE app_maintenance LOGIN BYPASSRLS PASSWORD '…'`), and
  `migrate` then checks and grants it. Without it, the worker's sweeps across
  tenants refuse to run (and say why).
- **Row-level security** ([tenancy](tenancy.md)): the same run sets `FORCE
ROW LEVEL SECURITY` on every tenant table (drizzle-kit emits only
  `ENABLE` and the policies) and refuses to finish when a table with a
  `tenant_id` lacks RLS, FORCE or its four policies. FORCE binds a table's
  owner too, unless it is a superuser (Compose's owner is): the owner never
  serves a request, and the app role, which does, is neither.
- **Upgrading to tenancy (1a)** is a reset, not a migration of data (the
  owner's call for app10). Add `POSTGRES_MAINTENANCE_PASSWORD=$(openssl rand -hex 24)`
  to `.env` first: the tenancy migration adds `tenant_id NOT NULL`
  with no default, which fails on tables that hold rows. Back up, then start
  from an empty database (`docker compose down`, remove the `postgres_data`
  volume, `docker compose up -d --build --remove-orphans`); the first start
  makes the operator tenant (`ADMIN_TENANT_NAME`) and the administrator.
- **Upgrading a deployment made before the roles** (app10): add
  `POSTGRES_APP_PASSWORD=$(openssl rand -hex 24)` to `.env` and redeploy
  (`docker compose up -d --build --remove-orphans`). `migrate` creates
  `app_runtime` and grants it everything; api and worker start on it. The
  tables stay the superuser's (`POSTGRES_USER`), which is the owner role here,
  so nothing is transferred. **Does your `.env` set `DATABASE_URL`
  itself?** Then Compose keeps using that value as the app's URL
  (`${DATABASE_URL:-…}`), and `migrate` refuses it: the same role in both
  URLs, or a role that "owns N relations". Move the value to
  `DATABASE_OWNER_URL` (that role keeps owning the tables) and remove
  `DATABASE_URL` from `.env`, so Compose builds the app role's URL from
  `POSTGRES_APP_PASSWORD`, or point `DATABASE_URL` at a new role of your own
  for the app.
- **Rolling back past this release** is not an image change alone
  ([Publishing and rolling back images](#publishing-and-rolling-back-images)):
  the previous image's `migrate` expects `DATABASE_URL` to be the owner's
  and creates the `drizzle` schema with it, which the app role may not, so
  it exits 1 and api and worker never start. Check out the previous
  release's Compose files with its image (`git checkout <previous SHA> --
compose.yaml compose.prod.yaml`, `APP_IMAGE` at that SHA), or run that one
  deploy with `DATABASE_URL` set to the owner's URL in `.env`. The new role
  itself is harmless to the old release.

## Database connections

Each process has its own pool. Their sum must stay under PostgreSQL's
`max_connections`, with a few left for administration and migrations:

```
API_REPLICAS × API_DATABASE_POOL_MAX + WORKER_REPLICAS × WORKER_DATABASE_POOL_MAX  <  POSTGRES_MAX_CONNECTIONS − 10
          2 × 10                     +           1 × 20                            =  40  <  90
```

When a process's pool runs short:

- **No hang:** a query waits at most `DATABASE_POOL_TIMEOUT_MS` for a
  connection, then the request answers `503 database_busy` with
  `Retry-After: 1` (a warning in the logs, not an error).
- **No connection held for ever:** PostgreSQL cancels statements past
  `DATABASE_STATEMENT_TIMEOUT_MS` (`503 database_timeout`) and ends sessions
  idle in a transaction past `DATABASE_IDLE_TX_TIMEOUT_MS`. Migrations run
  without the statement timeout.
- **Seen early:** `GET /health` shows `databasePool` (max, in use, idle,
  waiting); the `DatabasePool` logger warns every 5 s while queries wait or
  requests are refused; `pg_stat_activity.application_name` names the process
  (`<SERVICE_NAME>:api`, `:worker`).

Raising the pools: more API replicas need a smaller pool each, or
[PgBouncer](#pgbouncer) (transaction mode) in front of PostgreSQL, or a larger
`max_connections` (each connection costs PostgreSQL memory). Workers need a
pool at least as large as what they run at once (workflow steps, job
concurrency).

### PgBouncer

Optional, off by default: `compose.pgbouncer.yaml` puts PgBouncer between
the app and PostgreSQL, in **transaction pooling** mode, so the apps' many
client connections share a few server connections. Worth it when
`API_REPLICAS × API_DATABASE_POOL_MAX + WORKER_REPLICAS × WORKER_DATABASE_POOL_MAX`
no longer fits under `max_connections` (the sum above), or many replicas each
keep a mostly idle pool. One host with two replicas does not need it.

```bash
# .env: add the file to COMPOSE_FILE
COMPOSE_FILE=compose.yaml:compose.prod.yaml:compose.pgbouncer.yaml
docker compose up -d
```

- **What goes through it:** `api` and `worker` (`DATABASE_URL`, and the
  worker's `DATABASE_MAINTENANCE_URL`): the overlay points both at host
  `pgbouncer`. **What does not:** `migrate` (the owner: DDL, the role
  grants), `backup` (`pg_dump` holds one snapshot across statements, which a
  transaction-pooled connection cannot) and the monitoring exporter. They
  keep their direct connections, and count against `max_connections` as
  before.
- **Pool sizes per role** (`pgbouncer/entrypoint.sh` writes the
  configuration from the environment): `PGBOUNCER_POOL_SIZE` (20) server
  connections for the app role, `PGBOUNCER_MAINTENANCE_POOL_SIZE` (3) for the
  maintenance role, `PGBOUNCER_MAX_CLIENT_CONN` (400) client connections,
  `PGBOUNCER_QUERY_WAIT_TIMEOUT` (10 s: how long a client waits for a server
  connection). The new sum: `PGBOUNCER_POOL_SIZE +
PGBOUNCER_MAINTENANCE_POOL_SIZE + migrate/backup/exporter < POSTGRES_MAX_CONNECTIONS − 10`.
  The apps' own pools (`API_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`)
  now size how many requests run at once, no longer how many PostgreSQL
  connections they cost; `max_client_conn` must hold their sum, workers'
  maintenance pools (3 each) included.
- **The image:** `edoburu/pgbouncer` (Alpine, rebuilt for each PgBouncer
  release; PgBouncer publishes no image of its own), pinned by tag and digest;
  Dependabot's `docker-compose` updater raises both. Resources:
  `PGBOUNCER_CPUS` (0.5) and `PGBOUNCER_MEMORY` (128M).
- **Passwords in the environment only:** the overlay builds the URLs from
  `POSTGRES_APP_PASSWORD` and `POSTGRES_MAINTENANCE_PASSWORD`, as
  compose.prod.yaml does. With `DATABASE_URL_FILE` secrets, change the host in
  those files to `pgbouncer` yourself (and give the `pgbouncer` service the
  passwords). A managed PostgreSQL behind it: `PGBOUNCER_DB_HOST` and
  `PGBOUNCER_DB_PORT`, and leave `DATABASE_URL` pointing at `pgbouncer`.

**What transaction pooling takes away, and what the app does about it**
(read from the code, and exercised by `pgbouncer/check.sh`):

| Session feature                                                                         | In this app                                                                                                         | Through PgBouncer                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant settings (`app.tenant_id`, `app.read_tenants`, [tenancy.md](tenancy.md))         | `set_config(…, true)`: local to the transaction, sent with `begin` (`core/tenancy/tenant-pool.ts`)                  | Works, and it is the reason it can: nothing survives `COMMIT`, so a server connection never carries a tenant to the next client. A plain `SET` or `set_config(…, false)` would leak between clients: never add one                  |
| Advisory locks (views, approvals, revisions, sequences, tags, the seeders, migrations…) | all `pg_advisory_xact_lock`: released at `COMMIT`                                                                   | Works. A session-level `pg_advisory_lock` would not (it stays on a server connection another client reuses): use the `xact` form                                                                                                    |
| `LocksModule` (`@nestjs/locks`)                                                         | rows in a `locks` table with an owner and an expiry (`core/locks/drizzle-lock.store.ts`), not advisory locks        | Works                                                                                                                                                                                                                               |
| Prepared statements                                                                     | node-postgres sends parameterized queries unnamed; the app prepares nothing by name                                 | Works. PgBouncer 1.21+ also rewrites named protocol-level statements (`max_prepared_statements`, 200); SQL-level `PREPARE` is not supported                                                                                         |
| `statement_timeout`, `idle_in_transaction_session_timeout`                              | node-postgres sends both as **startup parameters** (`DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_TX_TIMEOUT_MS`) | PgBouncer refuses unknown startup parameters. `track_extra_parameters` lists both, so PgBouncer sets them on whichever server connection serves the client. Without that line the limits would be dropped or the connection refused |
| `application_name`                                                                      | `<SERVICE_NAME>:api`, `:worker` in `pg_stat_activity`                                                               | Tracked by default, but `pg_stat_activity` shows the **PgBouncer** connections: the name of whoever used it last, not a per-process count                                                                                           |
| `LISTEN`/`NOTIFY`, `WITH HOLD` cursors, session-level `SET`                             | not used (queues are in Redis; the outbox relay polls)                                                              | Would not work in transaction mode; a feature needing them connects to PostgreSQL directly                                                                                                                                          |

**Caveats, honestly:**

- **Errors when the pool is full differ.** The app's own pool answers
  `503 database_busy` after `DATABASE_POOL_TIMEOUT_MS`. A request that gets
  past it but waits at PgBouncer longer than `PGBOUNCER_QUERY_WAIT_TIMEOUT`
  fails with a database error the app does not map to `database_busy` (a 500).
  Keep `PGBOUNCER_POOL_SIZE` large enough for the apps' pools' busy peak, and
  watch PgBouncer's log for `query_wait_timeout`.
- **`GET /health`'s `databasePool` and the pool metrics** describe the
  apps' pools, not PgBouncer's; PgBouncer's own statistics (`SHOW POOLS`)
  are not exported by this stack (its admin console is off: `admin_users` is
  empty).
- **One more hop:** a few hundred microseconds per query, and a service that
  must be up: the apps wait for it (`depends_on`) and fail their queries while
  it restarts.
- **No TLS inside the Compose network** between the apps, PgBouncer and
  PostgreSQL, as without it. Across hosts, configure `client_tls_*` and
  `server_tls_*` in `pgbouncer/entrypoint.sh`.
- **A schema change that alters a result's type** can make PgBouncer's cached
  statements fail with "cached plan must not change result type"; the
  app prepares nothing by name, so it does not apply today. If you add a
  driver that does, `RECONNECT` on the admin console clears it.
- **Tested once, in CI** (`.github/workflows/pgbouncer.yml`, on changes to
  these files and the database code, and on demand): the load test's
  stack with the overlay on, the k6 scenarios (sign-in, tenant-scoped list,
  create, export) through PgBouncer, then `pgbouncer/check.sh`: the server
  connections stay inside the pool, the two limits take effect, a tenant
  setting and an advisory lock are gone after `COMMIT`. Locally:
  `LOADTEST_PGBOUNCER=on loadtest/run.sh up && pgbouncer/check.sh` after
  `loadtest/run.sh run`, then `LOADTEST_PGBOUNCER=on loadtest/run.sh down`.

## Log redaction

Credentials never reach a log line or an error report. One declared list,
`apps/api/src/core/logging/redaction.ts` (`logRedaction`), feeds everything
that masks:

- **Keys, masked by name at any depth.** `createLogger()` (main.ts) hands the
  list to Nest's own `ConsoleLogger` `redact` option, which masks a property
  of that name (case-insensitive) in structured params and logged objects,
  errors' `cause` included, in text and JSON mode. The list:
  - headers: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
    `X-Api-Key`, `X-Captcha-Token`, `X-CSRF-Token`, `X-XSRF-Token`,
    `Webhook-Signature`, `X-Signature`, `X-Hub-Signature(-256)`;
  - fields: passwords (`password`, `currentPassword`, `newPassword`…),
    tokens (`token`, `accessToken`, `refreshToken`, `idToken`, `jwt`),
    secrets and keys (`secret`, `clientSecret`, `pendingSecret`, `apiKey`,
    `privateKey`…), two-factor (`totp`, `otp`, `recoveryCode(s)`), sessions
    (`sessionId`, `sid`, `cookie(s)`), signatures, SNS's `Token` and
    `SubscribeURL`, and `body.code` / `query.code` (a two-factor or OIDC
    code there; every error's own `code` stays readable);
  - every environment variable declared with `secret()`
    ([configuration.md](configuration.md)), added by `env.ts`.
- **Text patterns, over every line written.** The `redact` option leaves
  string messages, error messages and stack traces as they are, so the
  logger (`RedactingConsoleLogger`) runs the patterns over the whole line:
  `Bearer`/`Basic` credentials, JWTs, PEM private keys, a URL's password
  (`postgres://app:[REDACTED]@db`), `name=value` / `name: value` for every
  declared name (`refreshToken=[REDACTED]`, a cookie pair), and the API keys'
  shape (`sk_<id>_[REDACTED]`: the id still finds the client). The name stays
  in the line, so it says what was removed.
- **NestJS Observe** (when configured) gets the same keys and patterns as
  `redaction.keys` / `redaction.patterns`, on top of its own defaults, for
  the errors and requests it captures and the log lines it forwards.
- **Sentry** (when `SENTRY_DSN` is set) gets every event, breadcrumb and
  transaction through `logRedaction.redactValue()` in its `beforeSend`
  ([Telemetry](#telemetry)).

Where that applies: the request log (method, path, status, never headers or
bodies), the problem-details filter's 5xx report (message and stack), every
`Logger` call (handlers, queue processors' failures, outgoing HTTP calls'
errors), and what the operations API sends a browser: the failure reasons of `GET /v1/ops/queues`, the dead letters of `GET /v1/ops/outbox` and the events of `GET /v1/ops/events` (`logRedaction.redactValue()`, which also drops stack traces and cuts long texts;
[webhooks-and-realtime.md](webhooks-and-realtime.md), "Ops"). Validation
errors name the field and never echo its value, so neither the problem
details nor the logs carry a rejected password.

**Adding to it.** Declare at import time, from module scope next to what
makes the secret: `logRedaction.declareFields('ssn')`, `declareHeaders('X-Partner-Token')`,
`declarePatterns(/acct_[a-z0-9]{16}/)` (use a lookbehind to keep an
identifying prefix). `createLogger()` snapshots the list and closes it; a
later declaration throws (see [pitfalls.md](pitfalls.md)). Only names that
always hold a secret belong in it: a key masks that name everywhere. The
encrypted-column registry plugs in here: `encrypted()` declares each
encrypted column's property with `declareFields()` ([encryption](encryption.md)).

What it is not: a guarantee. A secret logged under an innocent name, in a
shape no pattern knows, is written as is. Log ids, not payloads.

### ClamAV (malware scanning)

Optional: [attachments](attachments.md) can be scanned for malware.
`compose.clamav.yaml` adds a `clamav` service (the official `clamav/clamav`
image, pinned, which runs clamd and freshclam) and turns the scanner on for
`api` and `worker`:

```bash
# .env
COMPOSE_FILE=compose.yaml:compose.prod.yaml:compose.clamav.yaml
docker compose up -d
```

- **The network:** `scanning`, its own; only `worker` joins it (besides
  `default`) and clamd's port 3310 is not published. It is not `internal`:
  freshclam downloads the signatures (the first start takes a minute or
  two; `clamav_db` keeps them across restarts). Until clamd answers, scans
  fail and are tried again, and uploads stay `pending`.
- **Size:** clamd refuses a stream over `StreamMaxLength`; the file sets it
  (and `MaxFileSize`) to `CLAMAV_STREAM_MAX_MB`, default `ATTACHMENT_MAX_MB`.
  Raise `ATTACHMENT_MAX_MB` and it follows. Limits: `CLAMAV_CPUS` (1),
  `CLAMAV_MEMORY` (3G: the loaded signatures are about 1.5 GB).
- **Blue-green:** the colours (`api-blue`, `api-green`) extend
  `compose.prod.yaml`'s `api`, so they never get what the file sets on `api`.
  Put `MALWARE_SCANNER=clamav` and `CLAMAV_HOST=clamav` in `.env` as well:
  every service reads them from there (CI renders the combination and checks
  both colours). Forgotten, the colours run with the scanner off: their
  uploads are `clean` at once, unscanned, and nothing says so.
- **Off:** leave the file out of `COMPOSE_FILE` (`MALWARE_SCANNER=off`, the
  default): no scan and no `pending` state, as without this feature. Turning
  it on later leaves existing attachments `clean` (unscanned); turning it
  back off releases the uploads still `pending` as `clean` within minutes
  (nothing will scan them), audited as `attachments.released`.
- **Metric:** `attachments_scanned_total{result}` ([below](#metrics)).

## Metrics

`GET /metrics` serves Prometheus metrics (prom-client, `apps/api/src/core/metrics/`)
on every process, api and worker alike (port 3000): HTTP request durations
(`http_request_duration_seconds{method,route,status}`, `route` the matched
pattern such as `GET /v1/notes/{id}`, unmatched requests `unmatched`; the
scrape and `/health` are not measured), `http_requests_in_flight`, the
process's pool (`db_pool_connections{state="total|idle|waiting"}`), jobs
per queue and state (`queue_jobs{queue,state}`), the outbox
(`outbox_undelivered`, `outbox_dead_letters`, `outbox_lag_seconds`), the
outgoing webhooks (`webhook_deliveries{state="pending|due|failed"}`,
`webhook_delivery_lag_seconds`), approvals (`approvals_open{status="pending|changes_requested"}`,
`approvals_overdue_seconds`: how far the most overdue pending stage is past
its deadline, which its workflow should have escalated or expired;
`approvals_unapplied_seconds`: how long the oldest approved request has
waited for its outcome), the bot protection's verifications
(`captcha_verifications_total{outcome="passed|rejected|replayed|unavailable"}`,
a counter per process: `rate()` and sum it), password hashing (`password_hashes_in_flight`,
`password_hashes_queued`, `password_hashes_rejected_total{reason}`: per
process, [Resource limits](#resource-limits)), mail (`mail_sent_total`,
`mail_suppressed_total{reason}`, `mail_events_total{provider,type}`:
[deliverability](deliverability.md)), `deprecated_route_calls_total{route}` (calls to `@Deprecated()` routes: [api-conventions](api-conventions.md), "Deprecation"), `attachments_scanned_total{result="clean|infected|error"}` (malware scans of uploads, a counter per worker: [attachments](attachments.md)), `attachment_images_processed_total{result="ready|failed|error"}` (uploaded images processed, a counter per worker: [attachments](attachments.md#image-renditions)), `encrypted_rows_on_old_key{column}`
([encryption](encryption.md)), `exchange_rates_age_seconds`
([money](money.md)), `telemetry_rejected_total{target,status}` (uploads a
collector refused: 401, 403, 429; [Telemetry](#telemetry)), Node's defaults (`process_cpu_seconds_total`,
heap, event loop lag, GC) and the heap's limit (`nodejs_heap_size_limit_bytes`).
Queue, outbox, webhook and approval gauges are shared state: every process reports the
same values, so aggregate them with `max()`, not `sum()`. A gauge whose read
fails (PostgreSQL or Redis away) is left out of that scrape, not set to 0.

- **Off by default:** without `METRICS_TOKEN`, `/metrics` answers 404. Set it
  (`openssl rand -hex 24`, at least 16 characters); Prometheus then sends
  `Authorization: Bearer <token>` (`authorization: { credentials: ... }` in
  its scrape config), anything else gets 401.
- **Inside the Compose network only:** run Prometheus as a service of the
  stack (or on its network) and scrape every replica through Docker's DNS:

  ```yaml
  scrape_configs:
    - job_name: api
      authorization: { credentials_file: /etc/prometheus/metrics-token }
      dns_sd_configs: [{ names: [api, worker], type: A, port: 3000 }]
  ```

  `compose.monitoring.yaml` does this for you (below).

- **Not rate limited**, like `/health`: the limiter counts in Redis, and the
  scrape must keep working while Redis is away (its gauges then go absent).
- **Never through Caddy:** `caddy/Caddyfile` answers `/metrics` with 404
  before the proxy (`respond /metrics* 404`), so the token is never the only
  thing between the internet and the metrics. Keep that line when editing
  the Caddyfile.

### Alerting

`monitoring/` holds Prometheus alert rules and an optional stack that runs
them (`compose.monitoring.yaml`): Prometheus, Alertmanager, exporters for
PostgreSQL, Redis and the host (`node-exporter`), `blackbox-exporter` (HTTPS and the certificate,
through Caddy) and `backup-metrics` (the backup service's state). The
default stack doesn't need it, and nothing in it becomes required.

**Turn it on:** set `METRICS_TOKEN`, `POSTGRES_MONITOR_PASSWORD` (the
exporter's role, made by `migrate`: [Database roles](#database-roles)) and a
receiver (below) in `.env`, add the file to `COMPOSE_FILE`, deploy:

```bash
# .env: COMPOSE_FILE=compose.yaml:compose.prod.yaml:compose.monitoring.yaml
docker compose up -d
```

Prometheus scrapes every api and worker replica through Docker's DNS (the
token is a Compose secret, `/run/secrets/metrics_token`), the two exporters,
node-exporter (the host), the HTTPS probe, `backup-metrics`, itself and Alertmanager, every 15 s. Its data lives in the `prometheus_data`
volume: 30 days, at most 4 GB (`monitoring/prometheus/prometheus.yml`).
Limits: `PROMETHEUS_CPUS`, `PROMETHEUS_MEMORY`, `ALERTMANAGER_CPUS`,
`ALERTMANAGER_MEMORY`; the exporters get 0.25 CPU and 128 MB each (the
blackbox exporter 0.1 CPU and 64 MB). Logs are
bounded like the rest of the stack (`DOCKER_LOG_*`).

**The alerts** (46 rules in `monitoring/prometheus/alerts.yml`; critical: look now,
warning: look today):

| Alert                                                        | Fires when                                                                                                                                                                          | Severity          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `ApiDown`, `WorkerDown`                                      | no healthy api for 2 min; no worker for 5 min                                                                                                                                       | critical          |
| `TargetDown`                                                 | one scrape target fails for 5 min (a replica, an exporter; a wrong `METRICS_TOKEN`)                                                                                                 | warning           |
| `AppRestarting`                                              | a process never stays up 10 min within 30 min (crash loop, killed at its memory limit)                                                                                              | warning           |
| `HighErrorRate`                                              | over 5% of requests answer 5xx for 10 min (at least 0.1 request/s)                                                                                                                  | critical          |
| `HighLatency`                                                | api p95 above 1 s for 15 min (the SSE stream and unmatched requests left out)                                                                                                       | warning           |
| `DatabasePoolSaturated`                                      | queries wait for a pool connection at every scrape for 10 min (`503 database_busy` next)                                                                                            | warning           |
| `PasswordHashingSaturated`                                   | a process refused password hashes (503 `server_busy`) in every 5 min for 10 min: a sign-in flood or too little capacity ([Resource limits](#resource-limits))                       | warning           |
| `HeapNearLimit`                                              | heap above 85% of `API_HEAP_MB`/`WORKER_HEAP_MB` for 10 min                                                                                                                         | warning           |
| `EventLoopLag`                                               | event loop p99 above 500 ms for 10 min                                                                                                                                              | warning           |
| `QueueStalled`                                               | jobs wait and none runs for 10 min (no worker takes them, or the queue is paused)                                                                                                   | critical          |
| `QueueBacklogGrowing`                                        | over 100 jobs wait and more than 30 min ago, for 30 min                                                                                                                             | warning           |
| `JobsFailing`                                                | jobs failed after all their attempts in the last 15 min                                                                                                                             | warning           |
| `OutboxStuck`                                                | a due outbox message has waited over 5 min, for 5 min                                                                                                                               | critical          |
| `OutboxDeadLetters`                                          | outbox dead letters wait for someone (requeue or purge in `/v1/ops`)                                                                                                                | warning           |
| `WebhookDeliveriesLagging`, `WebhookDeliveriesFailing`       | a due delivery waits over 10 min; deliveries failed for good in the last hour                                                                                                       | warning           |
| `TenantStorageNearLimit` | a tenant stores over 90% of its storage limit for 15 min (`tenant_storage_bytes` / `tenant_storage_limit_bytes`; [Quotas](tenancy.md#quotas)) | warning |
| `ApprovalsOverdue`                                           | an approval stage is 15 min past its deadline (its workflow should have escalated or expired it)                                                                                    | warning           |
| `ApprovalsNotApplied`                                        | an approved request's outcome hasn't been applied (or failed) after an hour: its record stays locked                                                                                | warning           |
| `TelemetryRejected` | OTLP or Observe uploads were refused (401, 403, 429) for 5 min: a dead pipeline ([Telemetry](#telemetry)) | warning |
| `ExchangeRatesStale`                                         | the newest stored ECB rates are more than six days old (or none was ever fetched), for 2 h ([money.md](money.md))                                                                   | warning           |
| `DatabaseUnreachableFromApp`, `RedisUnreachableFromApp`      | a process answers but can't read PostgreSQL / Redis, for 2 min (works with managed services too)                                                                                    | critical          |
| `MailBounceRateHigh`, `MailComplaints`                       | over 5% of the mail sent in an hour bounced hard (at least 20 sent, for 15 min); any spam complaint in the last hour ([deliverability.md](deliverability.md))                       | warning           |
| `CaptchaProviderUnavailable`                                 | challenge verifications fail (timeout, error, open circuit) for 5 min: the sign-in routes run fail-open under the strict tier, or answer 503 ([auth.md](auth.md), "Bot protection") | warning           |
| `PostgresDown`, `RedisDown`                                  | the exporter can't reach it for 1 min                                                                                                                                               | critical          |
| `PostgresConnectionsHigh`                                    | connections above 80% of `max_connections` for 5 min                                                                                                                                | warning           |
| `RedisMemoryHigh`, `RedisPersistenceFailing`                 | above 85% of `maxmemory` (noeviction: writes fail at 100%); the AOF or a snapshot fails                                                                                             | critical          |
| `HttpsProbeFailing`                                          | Caddy hasn't answered the HTTPS probe with 200 for 3 min (Caddy down, a bad certificate, no healthy api behind it)                                                                  | critical          |
| `CertificateExpiring`                                        | the certificate expires within 14 days (warning) or 7 days (critical): Caddy's renewals fail                                                                                        | warning, critical |
| `BackupFailed`, `BackupTooOld`, `BackupNeverSucceeded`       | the last backup run failed; none succeeded for `BACKUP_MAX_AGE_HOURS` + 1 h; none at all for a day                                                                                  | warning           |
| `PrometheusRuleFailures`, `AlertmanagerNotificationsFailing` | the monitoring itself is broken (a rule, the SMTP settings, the Watchdog's URL)                                                                                                     | warning           |
| `HostDiskSpaceLow`, `HostDiskSpaceCritical`                  | a file system has under 10% (warning, 10 min) or 5% (critical, 5 min) free                                                                                                          | warning, critical |
| `HostDiskFillingUp`                                          | a disk over a third full is on course to fill within 24 h at the last six hours' pace (1 h)                                                                                         | warning           |
| `HostMemoryLow`, `HostOomKilled`, `HostCpuHigh`              | under 10% of memory available (10 min); the kernel killed a process for memory; CPUs over 90% busy (15 min)                                                                         | warning           |
| `Watchdog`                                                   | always: the dead man's switch (below), sent to its ping URL only                                                                                                                    | none              |

The rules read `monitoring/prometheus/recording.yml` (rates, p95, queue
numbers across replicas). Prometheus can't see Docker's healthchecks, so
`backup-metrics` (busybox, `monitoring/backup-metrics/serve.sh`) turns the
markers the backup service leaves in the `backups` volume (read only) into
`backup_last_success_timestamp_seconds` and
`backup_last_failure_timestamp_seconds`: the backup's own healthcheck, as
alerts. Not covered by the Compose probe: reaching the API from outside
(public DNS, the firewall); it runs inside the Compose network. That is the
outside probe's job (below).

**The host:** `node-exporter` (`prom/node-exporter`, pinned) mounts the
host's root read only at `/host`, runs in the host's process namespace, is
not published (Prometheus scrapes `node-exporter:9100`, job `node`) and gets
0.1 CPU and 64 MB. Six alerts (group `host`, pseudo file systems left out):
`HostDiskSpaceLow` (under 10% free, 10 min) and `HostDiskSpaceCritical`
(under 5%), `HostDiskFillingUp` (at the last six hours' pace the disk is
full within 24 h, once it is a third full), `HostMemoryLow` (under 10%
available), `HostOomKilled` (the kernel killed a process) and `HostCpuHigh`
(over 90% busy for 15 min). A host that is down is not one of them: nothing on it can report that, so
the dead man's switch and the outside probe say so.

- **Linux:** the numbers are the host's.
- **Docker Desktop (a Mac):** the exporter sees the Linux VM, which is still
  useful: `Docker.raw` is what fills, and `HostDiskSpaceLow` says so. The
  Mac itself needs a Homebrew `node_exporter` (`brew install node_exporter`,
  `brew services start node_exporter`, port 9100) and one more scrape job,
  which is yours to add to `monitoring/prometheus/prometheus.yml`
  (`host.docker.internal:9100`, job `mac`; the host rules read job `node`
  only, copy them for it). It isn't shipped: without the Homebrew exporter it
  would fire `TargetDown` for good.
- Off like the rest of the file: nothing starts unless `compose.monitoring.yaml`
  is in `COMPOSE_FILE`.

**The outside probe:** the whole host down, DNS, the firewall: nothing on
the host can report those, so the check comes from outside. Two ways, both
without a paid key, both off until you set them up:

1. **A scheduled GitHub Actions workflow** (`.github/workflows/uptime-probe.yml`):
   set the repository **variable** `UPTIME_PROBE_URL` (Settings, Secrets and
   variables, Actions, Variables), e.g. `https://api.example.com/health/live`.
   Hourly, three tries, `curl --fail` over HTTPS. Unset or empty: the job is
   skipped, not failed, and costs nothing. A failed run is the alert (GitHub
   mails the watchers; Settings, Notifications). Limits: hourly (to spare
   Actions minutes; scheduled runs can be late), disabled after 60 days
   without repository activity, and the URL must resolve publicly (not
   app10, whose name only `/etc/hosts` knows).
2. **The dead man's switch** (below) already alarms when the host stops
   sending: that covers a dead host without a public name. For a faster
   check, an uptime service's free tier (UptimeRobot, healthchecks.io's
   own HTTP checks) against the same URL.

**The HTTPS probe:** `blackbox-exporter` fetches
`https://caddy:443/health/live` every 15 s, by Caddy's Compose name, and
sends `PROBE_HOST` (default: `APP_DOMAIN`) as the TLS server name and the
`Host` header (`monitoring/blackbox/render-config.sh`). Caddy then serves
the real site with its real certificate, which is checked against that
name, and the answer must be the api's (`"status":"ok"`: Caddy answers an
empty 200 for a host it doesn't serve). Going by Caddy's name, not the
public one, works without public DNS (a host name that only `/etc/hosts` knows, and
containers don't read the host's `/etc/hosts`). `probe_success` feeds
`HttpsProbeFailing` (muted while `ApiDown`, `PostgresDown` or `RedisDown`
fires: no replica answers then, so the probe fails too; never by
an alert about one replica, which would hide a Caddy or certificate outage); `probe_ssl_earliest_cert_expiry` feeds
`CertificateExpiring`. Why a probe fails:

```bash
docker compose exec blackbox-exporter wget -qO- \
  'http://127.0.0.1:9115/probe?module=https_caddy&target=https://caddy:443/health/live&debug=true'
```

**The dead man's switch:** every alert above needs Prometheus, Alertmanager
and the host to be up to be sent at all. `Watchdog` (`vector(1)`) always
fires; Alertmanager sends it about once a minute to an outside check, on
its own route and receiver, never to the receivers below and with no
resolved message. When the pings stop, the outside check alarms. Off by
default: without a URL, the Watchdog goes to a receiver that sends nothing
(it still shows in the UIs), and the stack starts as before.

1. At [healthchecks.io](https://healthchecks.io) (the free tier is enough):
   add a check, schedule "Simple", **period 1 minute, grace 5 minutes**
   (a restart of Prometheus or Alertmanager stays quiet), and set its
   notifications (mail, Slack, a phone) there: they are what tells you the
   monitoring is gone. Copy its ping URL (`https://hc-ping.com/<uuid>`).
2. Put the URL in a file outside the repository, readable by the container
   (Alertmanager runs as `nobody`; the directory around it keeps others out),
   and point `.env` at it. Compose mounts it as the `alert_watchdog_url`
   secret, which Alertmanager reads itself (`url_file`): the URL is in no
   variable and no rendered file.

   ```bash
   install -d -m 700 ~/secrets
   printf '%s\n' 'https://hc-ping.com/<uuid>' > ~/secrets/alert_watchdog_url
   chmod 644 ~/secrets/alert_watchdog_url
   # .env: ALERT_WATCHDOG_URL_FILE=/Users/<you>/secrets/alert_watchdog_url (absolute; Linux: /home/<you>/...)
   # A changed secret file alone doesn't recreate the container: force it.
   docker compose up -d --force-recreate alertmanager
   ```

   Or set `ALERT_WATCHDOG_URL` in `.env` instead (the secret file wins when
   both are set). Without `ALERT_WATCHDOG_URL_FILE`, Compose mounts the empty
   `monitoring/alertmanager/watchdog-url.empty`.

3. The check turns green within a minute or two. To test it, stop
   Alertmanager (`docker compose stop alertmanager`): healthchecks.io alarms
   after the period plus the grace time.

When Prometheus itself dies, Alertmanager keeps the Watchdog until its
`endsAt` (about 4 minutes after the last evaluation) and pings until then:
the alarm comes after about 4 minutes plus the period plus the grace.

A URL that stops working (the check deleted) fires
`AlertmanagerNotificationsFailing` (integration `webhook`).

**Where they go:** Alertmanager writes its configuration from `.env` at
start (`monitoring/alertmanager/render-config.sh`), so no secret is in git:

- `ALERT_EMAIL_TO`: mail, through `ALERT_SMTP_URL` (default: the app's
  `SMTP_URL`), from `ALERT_EMAIL_FROM` (default: `MAIL_FROM`). Mail through
  Resend, Postmark or SendGrid's API isn't SMTP: set `ALERT_SMTP_URL` to
  their SMTP relay.
- `ALERT_WEBHOOK_URL`: Alertmanager's JSON, to anything that takes it.
- `ALERT_SLACK_WEBHOOK_URL`: a Slack incoming webhook.

Any of them, or several. None: alerts only show in the UIs. Alerts are
grouped by name, sent after 30 s, repeated every 12 h while they fire
(critical: every 2 h), and once more when resolved. A critical alert mutes
the warning of the same name; `PostgresDown` and `RedisDown` mute the app's
view of the same outage.

**Looking at it:** the UIs listen on the host's loopback only
(`PROMETHEUS_PORT` 9090, `ALERTMANAGER_PORT` 9093). From your machine:

```bash
ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 <host>
# then http://localhost:9090/alerts (and /targets), http://localhost:9093
```

On the host itself, without a browser:
`docker compose exec prometheus wget -qO- localhost:9090/api/v1/alerts`.

**Silencing** (planned work, a known issue): "New Silence" in the
Alertmanager UI, or amtool in its container. Silences survive restarts.

```bash
docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 \
  silence add alertname=HighLatency --duration=2h --comment="load test"
docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 silence query
```

**Changing the rules:** edit `monitoring/prometheus/alerts.yml`, add or
adjust its test in `monitoring/prometheus/tests/`, then reload with
`docker compose kill -s HUP prometheus`. `.github/workflows/monitoring.yml`
runs `promtool check config`, `promtool check rules`, `promtool test rules`
and `amtool check-config` on every change. Locally:

```bash
docker run --rm -v "$PWD/monitoring/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v3.15.0 test rules /etc/prometheus/tests/alerts.test.yml
```

**Managed PostgreSQL or Redis:** the exporters follow `DATABASE_MONITOR_URL`
(the monitoring role `migrate` made there, [Database roles](#database-roles))
and `REDIS_URL`. With Redis
Sentinel, remove `redis-exporter` and its scrape job; the app's own
`RedisUnreachableFromApp` still covers Redis.

### Logs

Logs live in Docker's files, bounded by `DOCKER_LOG_*`. To search them
across containers, `compose.monitoring.yaml` has an optional log pipeline:
**Loki** (storage and queries) and **Grafana Alloy** (the collector), plus
**Grafana** as the UI. All three have Compose profiles, so they are off even
when the file is in `COMPOSE_FILE`:

```bash
# .env: COMPOSE_FILE=compose.yaml:compose.prod.yaml:compose.monitoring.yaml
#       COMPOSE_PROFILES=logs            # Loki + Alloy
#       COMPOSE_PROFILES=logs,grafana    # and Grafana (GRAFANA_ADMIN_PASSWORD required)
docker compose up -d
```

- **Alloy, not Promtail.** Grafana ended Promtail's life on 2026-03-02; Alloy
  is its documented successor. `monitoring/alloy/config.alloy` discovers this
  Compose project's containers (`discovery.docker`, filtered by the project
  label), reads them with `loki.source.docker` and pushes to Loki. Labels:
  `service` (api, worker, caddy, ...), `container`, `job="docker"`, `level`.
- **The log driver.** Alloy reads through the Docker API (the socket,
  mounted read only), so it works with the default `local` driver and with
  `json-file`: anything `docker logs` can print. Drivers Docker can't read
  back (`syslog`, `gelf`, `awslogs`, `fluentd`, `none`) leave Alloy with
  nothing, and then the shipper belongs to that driver, not here. Set
  `DOCKER_LOG_DRIVER=json-file` only for a collector that tails the files in
  `/var/lib/docker/containers` (Promtail-style, or Vector); Alloy doesn't
  need it. The socket gives Alloy the whole Docker API, even read only, so it
  runs as root; it is not published.
- **Retention.** `LOKI_RETENTION` (default `720h`, 30 days), enforced by
  Loki's compactor (`retention_enabled`, `monitoring/loki/loki.yml`). The
  chunks live in the `loki_data` volume; budget the disk for it. Change the
  value and `docker compose up -d loki`.
- **Redaction is unchanged.** The app masks secrets before it writes a line
  ([Log redaction](#log-redaction)); Alloy ships those lines as they are and
  adds no parsing that could un-mask anything. Anything Caddy or PostgreSQL
  log is shipped as written.
- **Loki is not published** (no authentication: `auth_enabled: false`);
  Alloy and Grafana reach it as `loki:3100`. Grafana listens on
  `127.0.0.1:${GRAFANA_PORT:-3001}`: reach it through an SSH tunnel, like
  Prometheus (`ssh -L 3001:127.0.0.1:3001 <host>`), sign in as `admin` with
  `GRAFANA_ADMIN_PASSWORD`, open Explore. The Loki data source is
  provisioned (`monitoring/grafana/provisioning/datasources/loki.yml`).
- **Limits:** `LOKI_CPUS`/`LOKI_MEMORY` (0.5, 512 MB), `ALLOY_*` (0.25, 256
  MB), `GRAFANA_*` (0.5, 256 MB).

**Querying by `requestId`.** In production the app writes one JSON object per
line (`LOG_FORMAT=json`), and every request carries an id: the
`X-Request-Id` header, which the response returns and an error body's
`requestId` repeats. Alloy turns `requestId` into structured metadata
`request_id` (not a label: it is unbounded), and `level` into a label.
In Grafana's Explore (LogQL):

```logql
{service=~"api|worker"} | request_id = "7c1b0f0e-6e0f-4a43-9d3c-2f1d0a9c1e55"
{service="api", level="error"} | json | status >= 500
{service="api"} |= "7c1b0f0e" | json
```

Without Grafana the UI is missing, not the data: it stays in Loki, and
`logcli` works against an SSH tunnel to a port you publish yourself.

**Checks.** `.github/workflows/monitoring.yml` verifies `loki.yml`
(`loki -verify-config`) and parses `config.alloy` (`alloy fmt`) on every
change, with the images `compose.monitoring.yaml` pins.

## Redis

**Redis 7.0 or newer** (Compose runs 8). The bot-protection counters
(`EXPIRE … NX`: a fixed window that starts with the first attempt,
[auth.md](auth.md), "Bot protection") and the API usage counters use
`EXPIRE` with its `NX` option, which Redis 7.0 added; on an older server
the command fails with a syntax error, and so does every sign-in the
challenge guards. The app reads `INFO server` at start
(`RedisLifecycle`, `core/redis/redis.ts`) and refuses to start on an
older version with a message naming both: `Redis 6.2.14 is too old: the
app needs Redis 7.0.0 or newer`. A server that doesn't answer within two
seconds, or names no version (a proxy), is left alone with a warning. A
managed Redis (or Valkey, which reports a `redis_version` of 7 or 8) is
fine on a current tier; check the version its console shows before
pointing `REDIS_URL` at it.

**Hosted instead:** NestJS Observe (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`)
is the hosted alternative: traces, metrics and errors go to the service, and
alerting is set up there, with nothing to run on the host. It is one option
of three, none required and all able to run side by side: Observe, your own
collector over OpenTelemetry, and Sentry for errors ([Telemetry](#telemetry)).

Observe wraps every provider in a proxy, which breaks code keyed by the real
instance. `core/observability/observe.ts` (`skipObserve`, Observe's
`skipInstrumentation`) leaves two kinds of provider unproxied: the
`@nestjs/mail` transports (downleveled `#fields` throw "Cannot read private
member") and every class with a `@OnOneInstance()`/`@WithoutOverlapping()`
method (`@nestjs/locks` looks the job up by instance), the latter found by
the marker the decorators leave, so new jobs need no listing. They get no
spans of their own methods. `observe.spec.ts` runs them through Observe's real
instance decorator. Both are upstream defects (`@nestjs/observe` should treat
downleveled private fields and wrapped receivers like native `#` members;
`@nestjs/locks` shouldn't key by instance identity): file them, then drop the
exclusion.

## Telemetry

Three independent switches, each off until its variable is set, so a project
is not tied to one hosted vendor:

- **`OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET`:** NestJS Observe (above),
  hosted traces, metrics and errors.
- **`OTEL_EXPORTER_OTLP_ENDPOINT`** (and `OTEL_EXPORTER_OTLP_HEADERS` for the
  collector's credential, e.g. `x-honeycomb-team=KEY`): OpenTelemetry through
  `@opentelemetry/sdk-node`. Traces and metrics go over OTLP/HTTP to any
  collector (Grafana Tempo, Jaeger, Honeycomb, Datadog): spans for HTTP,
  Express, PostgreSQL and Redis (the commands of a request), and runtime
  metrics. The SDK reads the standard `OTEL_*` variables too
  (`OTEL_SERVICE_NAME`, defaulting to `SERVICE_NAME`; `OTEL_TRACES_SAMPLER`,
  …).
- **`SENTRY_DSN`** (and `SENTRY_TRACES_SAMPLE_RATE`, 0 to 1): Sentry
  (`@sentry/nestjs`) gets the 5xx the problem-details filter answers, with
  the request id and error code as tags. Errors only unless the sample rate
  is set.

`main.ts` awaits `core/observability/instrument.ts` (after the development
settings) before it loads anything else: the SDKs patch `http`, Express and
the database and Redis clients as they load, so they start first. The app's
modules are imported with `await import()` after it, not as static imports
below it: a module's top-level `await` holds back only the modules that
import it, so static imports would load Nest, Express and `pg` while the SDKs
were still starting, and nothing would be traced. The packages are imported
only when their variable is set. Libraries loaded through `require` or a CJS
`import` (Express, `pg`, `ioredis`) are instrumented. NestJS's own
instrumentation (`@opentelemetry/instrumentation-nestjs-core`) does not
support Nest 12 yet, so there are no spans of controllers and providers.

The SDKs start before the environment is validated, so they read their `_FILE`
secrets themselves (`SENTRY_DSN_FILE`, `OTEL_EXPORTER_OTLP_HEADERS_FILE`,
[Secrets in files](#secrets-in-files)); a file that can't be read is reported
by the validation, which stops the app.

- **The trace id is in every log line** while a span is active: `traceId` in
  JSON lines, `[trace <id>]` in text lines. It finds the trace in the
  collector from a log line, and the request's logs from a trace.
- **Secrets stay out.** Sentry events, breadcrumbs and transactions are
  scrubbed in `beforeSend` by the log-redaction registry
  ([Log redaction](#log-redaction)): the same names and patterns, nothing
  declared twice, and Sentry collects no user, cookies, bodies or query strings (`dataCollection`). Spans carry the route
  pattern and status, not headers or bodies, and the values of the query
  parameters the registry names (`code` and `state` of an OIDC callback,
  `token`, `password`, …) are masked in `url.query` and `url.full`, on top of
  the instrumentation's own (`sig`, `X-Amz-Signature`, …). The list is read
  when the SDK starts: a name a feature declares later is not in it.
- **Error tracking is an adapter.** `ErrorTracker`
  (`core/observability/error-tracker.ts`) is the interface the filter
  reports to: Sentry when `SENTRY_DSN` is set, otherwise nothing. Inject it
  to report an error you handled; another vendor is one subclass and a line
  in `errorTracker()`. Sentry's own `SentryGlobalFilter` is not used: the one
  problem-details filter owns every error response.
- **A dead pipeline is noticed.** An exporter the collector turns away (HTTP
  401/403 or 429: a revoked key, an exhausted plan) is counted as
  `telemetry_rejected_total{target="otlp|observe",status}` on `/metrics`
  (OTLP: the exporters' answers; Observe: its refusal log lines, "Telemetry
  rate-limited (429)", because it has no hook), and the `TelemetryRejected`
  alert fires after 5 minutes ([Alerting](#alerting)). The OTLP exporters
  report a 429, 502, 503 or 504 whose retries ran out as one "retryable"
  failure without the status, counted as 429; other timeouts and 5xx are left
  to the exporters' retries. Every series starts at 0 (Prometheus' `increase()`
  needs a sample before the first count: Observe refuses once, then pauses its
  uploads until the app restarts, so its alert is that one event). Sentry's
  SDK drops events it is rate-limited on without telling the app: watch its
  quota page.
- **Crashes still crash.** Sentry's default `OnUnhandledRejection`
  integration is left out (`LEFT_OUT` in `sentry.ts`): with a listener for
  `unhandledRejection` Node no longer ends the process on a floating
  rejection, which is how a project without `SENTRY_DSN` is restarted by
  Compose, and the integration only logs. Without it Node raises the
  rejection as an uncaught exception, which Sentry's `OnUncaughtException`
  integration reports before the process exits: the same behaviour with or
  without Sentry.
- **Compatibility with the instrumentation.** Observe's proxies broke the
  mail transports and lock-decorated jobs (`skipObserve`, above).
  OpenTelemetry and Sentry patch module functions, not provider instances,
  so they need no such exclusion, and CI proves it: the `e2e-telemetry` job
  runs a shard of the e2e suite with `OTEL_EXPORTER_OTLP_ENDPOINT` and
  `SENTRY_DSN` pointing at a stub collector
  (`apps/api/test/telemetry-stub.mjs`) and fails if no span of a request the
  app served reached it. `apps/api/test/setup-env.ts` starts the SDKs when
  either variable is set, before it loads the app: the order that works, so
  the suite alone cannot show a wrong one in `main.ts`. The job ends by
  building the API and starting `node dist/main` against a collector of its
  own (`node apps/api/test/telemetry-stub.mjs boot`, with `DATABASE_URL`,
  `DATABASE_OWNER_URL`, `DATABASE_MAINTENANCE_URL` and `REDIS_URL` set, as for
  the browser tests): the credentials are `_FILE` secrets, and it fails unless
  the request it sent was traced (HTTP, Express and `pg` spans) with the
  secrets of its query string masked. Locally, run the stub
  (`node apps/api/test/telemetry-stub.mjs serve`) or Jaeger
  (`jaegertracing/all-in-one`, OTLP on 4318) and point the variables at it.
- **Not covered:** logs over OTLP, and ESM-only libraries (they need Node's
  `--import` hook, `module.register`). Add them when a library you use needs
  it.

## Operator CLI

The break-glass path when nobody can sign in: `pnpm ops <command>` in
development, `docker compose run --rm api node dist/cli <command>` on a
deployment (`src/cli`, [nest-commander](https://docs.nestjs.com/recipes/nest-commander)
over the app's own services). It is a process of its own, not a route: it
opens no port, runs no workers (`APP_ROLE=api`, as the demo seed) and is
reachable only by whoever can run a container with the deployment's
environment (the database URL, the keys). Nothing in the API calls it.

| Command | What it does |
| --- | --- |
| `tenant:list` | the tenants: id, slug, members, active |
| `user:list <tenant>` | a tenant's users (id or slug): roles, two-factor, active |
| `admin:create <email> [--tenant <id\|slug>] [--name <name>]` | an administrator of a tenant (`--tenant` is optional when the deployment has one tenant). A new address gets an account (verified) and a one-time password; an existing account keeps its password and becomes the tenant's administrator |
| `user:reset-password <email>` | a new one-time password; every session and token client of the account is signed out |
| `user:remove-mfa <email>` | removes the authenticator and the recovery codes, clears the failed-code counter, revokes the account's tokens |
| `user:unlock <email>` | clears the failed second-factor attempts (the 15-minute lockout) and takes the address off the mail suppression list. Per-address rate limits (Redis) lapse by themselves within minutes |
| `setting:delete <key> (--tenant <id\|slug> \| --platform)` | removes a stored value; the next scope's, or the default, holds again |

- **Each command shows what it will do and asks** (`Proceed? (y/N)`).
  `--yes` skips the question, for scripts; without it a terminal is needed
  (`docker compose run` allocates one; with `-T` or a pipe, pass `--yes`).
- **One-time passwords** are printed to the terminal once, from the
  process's stdout, never through the application's logger (so in no log
  line, whatever `LOG_LEVEL`) and in no audit entry (only the hash is
  stored). They are 24 random characters; their owner changes them after
  signing in.
- **Audited as `system:ops`** ("System: Operator CLI"): each command writes
  an `ops.*` entry (`ops.admin-created`, `ops.password-reset`,
  `ops.mfa-removed`, `ops.user-unlocked`, `ops.setting-deleted`) with
  `details.via = 'cli'` and `details.operator = { user, host }` (the OS
  user of the shell, the container's host name), in the same transaction as
  the change. The services it goes through add their own (`setting.reset`
  and the like). An account's own change (a password, two-factor) is
  recorded outside any tenant, as the account's own, and told to its owner
  (a security notification, mail included) like any other change of their
  credentials. Tenant work runs in that tenant ([tenancy](tenancy.md),
  "The tenant of the work").
- **Not a tenant's door:** the CLI changes accounts and a few values; it
  reads no records, and `user:list` shows no secrets.

```bash
docker compose run --rm api node dist/cli tenant:list
docker compose run --rm api node dist/cli user:reset-password admin@example.com
docker compose run --rm api node dist/cli setting:delete auth.requireMfa --tenant acme --yes
```

On the Compose deployment (`.env` sets `COMPOSE_FILE`), `api` is
`compose.prod.yaml`'s service; with blue-green, run it as `api-blue` (or
`api-green`), which extends it. On Swarm, run the image on the stack's
network: `docker run --rm -it --network <stack>_default --env-file .env
$APP_IMAGE node dist/cli …` ([Swarm](deploy-swarm.md)). The command needs
what the app starts with (`DATABASE_URL`, `REDIS_URL`, `DATA_ENCRYPTION_KEYS`,
`MFA_ENCRYPTION_KEYS`, …: the same environment as `api`), nothing more, and runs against the live database: nothing is stopped.

**Locked out (the 2026-10-21 case, #393).** The only administrator of a
tenant set `auth.requireMfa` on without an authenticator, so no sign-in
could reach the enrolment. Recover without SQL:

```bash
docker compose run --rm api node dist/cli tenant:list                       # the tenant's slug
docker compose run --rm api node dist/cli setting:delete auth.requireMfa --tenant <slug>
# the administrator signs in with the password again, enrolls, then turns the policy on
```

If the password is lost as well: `user:reset-password <email>`; with no
administrator left at all: `admin:create <email> --tenant <slug>`. A
second-factor device lost: `user:remove-mfa <email>`. An administrator's
account locked by failed codes: `user:unlock <email>`. More:
[auth](auth.md), "Locked out".

## Migrations

`node dist/migrate` connects as the owner (`DATABASE_OWNER_URL`), applies
the app's migrations (under an advisory lock), then `nest-outbox`,
`nest-workflows` and `nest-webhooks` migrate their own schemas, then creates
or checks the app role of `DATABASE_URL` and its grants ([Database
roles](#database-roles)). The containers run with `MIGRATE_ON_START=off`. In
development, the app does the same at startup, as `DATABASE_OWNER_URL`, before
opening its own pool as the app role.

`migrate` runs while the previous release still serves, and a rollback runs
the previous image on the new schema (migrations don't roll back). So a
release's migrations must leave the release before it working: drop, rename
or retype only a release after the code stopped using it
([pitfalls](pitfalls.md), "Migrations: expand/contract"). CI's
`migration-lint` flags what breaks that.

## Backups and restore

The `backup` service (`backup/`) dumps the database on a schedule, keeps the
dumps in the `backups` volume, and copies each one off the host when
`BACKUP_S3_BUCKET` is set. Without it, a deploy works the same, with local
copies only: a lost disk loses them too, so set it.

- **What:** `pg_dump --format=custom` of `POSTGRES_DB`, one consistent
  snapshot taken while the app runs, checked by reading its contents back
  (`db-<time>.dump`). With `STORAGE_DRIVER=local`, the uploaded files too
  (`files-<time>.tar.gz` of the `app_storage` volume, mounted read only),
  taken after the dump, so every file a row points to is in it. With
  `STORAGE_DRIVER=s3` the files stay in their bucket: turn on its
  versioning. Each backup has a `.sha256` beside it.
- **When:** `BACKUP_SCHEDULE` (cron, UTC; `0 3 * * *`). An hourly check
  runs one when the last run failed or the newest backup is older than
  `BACKUP_MAX_AGE_HOURS` (25): a host that was off or asleep catches up,
  and a failed run is retried every hour. The same check runs once when
  the container starts (after the database answers), so a new stack gets its
  first backup at once instead of at the next schedule. With a less frequent schedule,
  raise `BACKUP_MAX_AGE_HOURS` to match.
- **The image** (`backup/Dockerfile`): `postgres:18.6-alpine` without `gosu`
  (never used: it runs as `postgres`), rclone, and supercronic built from
  its release tag with a current Go, so Go's fixes reach it. CI scans it
  like the app image. Dependabot raises the base images;
  `SUPERCRONIC_VERSION` is raised by hand.
- **Kept:** `BACKUP_RETENTION_DAYS` (14) in the volume, older ones removed
  after each complete run (never after a failed one). Off the host, nothing
  is deleted: give the bucket a lifecycle rule (delete after 90 days, say).
- **Off the host:** `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT` (R2:
  `https://<account id>.r2.cloudflarestorage.com`; empty: AWS),
  `BACKUP_S3_REGION` (R2: `auto`), `BACKUP_S3_ACCESS_KEY_ID`,
  `BACKUP_S3_SECRET_ACCESS_KEY` (empty: the host's IAM role),
  `BACKUP_S3_PREFIX` (`COMPOSE_PROJECT_NAME`), `BACKUP_S3_PROVIDER` (rclone's
  name; it guesses from the endpoint). The bucket must exist.
- **Its own bucket and keys**, not the app's `S3_*`: someone with the app's
  keys must not be able to delete the backups. The backup needs only to
  write and read back objects (S3: `s3:PutObject` and `s3:GetObject` on the
  prefix; R2: an Object Read & Write token for that bucket alone). Versioning
  or a lock (S3 Object Lock, R2 bucket locks) keeps them safe even from those
  keys.
- **Watching it:** each run logs one JSON line, `backup done` (file, bytes,
  objects, files, offsite, seconds) or `backup failed` (the step: dump,
  files, upload…); a failed run exits non-zero. `docker compose ps` shows
  `unhealthy` after a failed run, or when no backup succeeded for
  `BACKUP_MAX_AGE_HOURS` plus an hour.
- **Cost:** one database connection while it runs (`<SERVICE_NAME>:backup`
  in `pg_stat_activity`), within the margin above; `BACKUP_CPUS` (0.5) and
  `BACKUP_MEMORY` (512M). It connects as the owner (`POSTGRES_USER`): the
  role that owns every table reads every table, and a restore creates,
  renames and drops databases. The password is the `PGPASSWORD` of its
  environment, never in a command line. The dump carries no role, but its
  tables carry the app role's grants and the owner's default privileges;
  the script restores with `--no-owner` (everything becomes the owner's) and
  `--no-privileges` (the grants are skipped, since a new cluster has no
  `app_runtime` yet), and the `migrate` run of the next `docker compose up
-d` grants the app role everything again. A restore by hand (`pg_restore`
  yourself) needs the same two flags, or the app role created first.
- **Why pg_dump** (not pgBackRest or WAL-G): one host, one database. A dump is
  one file that restores into any PostgreSQL 18 or newer, and the server
  needs no change (no WAL archiving, no restart). The price: a restore
  loses what happened since the last dump. To lose less, back up more often
  (`0 */6 * * *`), turn on [point-in-time recovery](#point-in-time-recovery)
  (off by default), or move to a managed PostgreSQL with its own (Scaling
  further).
- **Encrypted**, optionally: [Encryption](#encryption-of-backups) (`age`), so
  the bucket never holds plaintext.
- **Managed database** (`DATABASE_URL` elsewhere): use its backups and drop
  `backup` from the stack (with `STORAGE_DRIVER=s3`, nothing else is on the
  host).

```bash
docker compose exec backup backup             # a backup now (exit code 0: done)
docker compose exec backup ls -l /backups     # the local ones
docker compose exec backup backup-fetch       # the off-host ones, newest first
docker compose logs backup                    # what each run did
```

### Restoring

The dump is loaded into a new database first; only once that worked are the
two swapped. The current database is kept, renamed
`<POSTGRES_DB>_before_restore_<time>`, until you drop it.

1. **Pick the backup:** `docker compose exec backup ls -l /backups`. On a new
   host, deploy the stack with the old `.env` first (same
   `COMPOSE_PROJECT_NAME`, so the same prefix), then list the off-host
   copies with `docker compose exec backup backup-fetch` and copy one (with its
   `.sha256`) into the volume with `docker compose exec backup backup-fetch
db-<time>.dump` (and its `files-<time>.tar.gz`). Listing and reading the
   bucket may need keys with more rights than the backup's own (`-e
BACKUP_S3_ACCESS_KEY_ID=… -e BACKUP_S3_SECRET_ACCESS_KEY=…`).
2. **Stop the app:** `docker compose stop api worker`.
3. **The database:** `docker compose exec backup restore db-<time>.dump`.
   It checks the checksum and asks you to type the database name (`--yes`
   skips that); it ends sessions still connected.
4. **The files** (`STORAGE_DRIVER=local`), from the same time: the service
   mounts them read only, so mount the volume again, writable, as root (the
   files keep the app's owner):

   ```bash
   docker compose run --rm --user root \
     --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
     -v app_storage:/restore -e BACKUP_STORAGE_DIR=/restore \
     backup restore files-<time>.tar.gz
   ```

   The `--cap-add`s: the service drops every capability, and root without
   them can't write into a directory the app owns, nor read a backup that is
   mode 600 and the `postgres` user's (`DAC_OVERRIDE`), keep the files'
   owner (`CHOWN`) or set their modes and times (`FOWNER`).

   They are extracted over what the volume holds; files no row points to
   are removed later by the orphan sweep.

5. **Start the app:** `docker compose up -d` (`migrate` runs first: it
   brings an older dump up to this version and grants the app role what the
   restore skipped, `--no-privileges`; until then api and worker can't read
   the restored tables).
6. **Check, then drop the previous database:**
   `docker compose exec backup dropdb <POSTGRES_DB>_before_restore_<time>`.

**Try a restore now and then**, without touching the app: `docker compose
exec backup sh -c 'PGDATABASE=restore_check restore db-<time>.dump --yes'`
loads it into a database `restore_check` beside the app's. Look at it
(`docker compose exec backup psql -d restore_check -c '\dt'`), then
`docker compose exec backup dropdb restore_check`.

### Encryption of backups

Off by default. With `BACKUP_ENCRYPTION_KEY` set, every dump, files archive,
base backup and WAL segment is encrypted with [age](https://age-encryption.org)
before it is kept or uploaded: the volume and the bucket hold `…​.age` files
only (checksums are of the encrypted file). The key is a **public** recipient,
so the server can encrypt and never decrypt: a stolen host or bucket gives
away no backup. It is `age1…` (several on one line, separated by spaces, so a
second person can decrypt too) or an SSH public key, a whole line
(`BACKUP_ENCRYPTION_KEY="ssh-ed25519 AAAA… me@laptop"`). To mix them, or give
several SSH keys, use `BACKUP_ENCRYPTION_KEY_FILE`: one recipient per line.

```bash
age-keygen -o backup.key        # keep it OFF the server (password manager, safe)
# Public key: ... age1xxxxxxxx   -> BACKUP_ENCRYPTION_KEY in .env
```

Losing the identity (`AGE-SECRET-KEY-…` in `backup.key`) makes every encrypted
backup unreadable: store it somewhere that outlives the host, and try a
restore from the bucket now and then. Existing plaintext backups stay as they
are (old ones age out by `BACKUP_RETENTION_DAYS`; the bucket's lifecycle rule
removes the rest). `BACKUP_ENCRYPTION_KEY_FILE` is read too, for a mounted
file (a Docker secret, [Secrets in files](#secrets-in-files)). To restore,
give the identity for that one command only:

```bash
docker compose run --rm -e BACKUP_DECRYPTION_KEY="$(cat backup.key)" backup restore db-<time>.dump.age
```

(`BACKUP_DECRYPTION_KEY_FILE` names a file in the container instead.) `restore`
decrypts into a private, temporary directory of the volume and removes it
afterwards. `backup-fetch` copies encrypted names like any other.

### Point-in-time recovery

Off by default. A dump restores to the moment it was taken (up to a day
back); with point-in-time recovery (PITR) a restore can stop at any moment
after the oldest base backup kept, e.g. the minute before a bad deploy
deleted rows. It uses what PostgreSQL itself documents (continuous
archiving, `pg_basebackup`, `recovery_target_time`), not extra daemons:

- **WAL archiving:** PostgreSQL's `archive_command` copies each finished WAL
  segment to the `wal_archive` volume (`archive_timeout` 300 s,
  `BACKUP_WAL_ARCHIVE_TIMEOUT`: a quiet database still closes a segment every
  five minutes, the most a lost disk can cost besides the last minute).
- **Base backups:** each scheduled `backup` run adds `base-<time>.tar.gz`
  (`pg_basebackup`, plain tar of the cluster) and `base-<time>.walstart` (the
  first segment it needs). Retention (`BACKUP_RETENTION_DAYS`) removes old base
  backups, and the WAL before the oldest one kept.
- **Off the host:** with `BACKUP_S3_BUCKET`, `backup-wal-ship` sends new segments
  to `<prefix>/wal/` every minute (encrypted when the key is set); the
  service turns `unhealthy` after 30 minutes without a pass.
  Without a bucket the archive lives on the same disk as the database.

Turn it on (needs a PostgreSQL restart, a few seconds of downtime):

```bash
# .env
COMPOSE_FILE=compose.yaml:compose.prod.yaml:compose.pitr.yaml
docker compose up -d --build
docker compose exec postgres sh -c 'cat "$PGDATA/pg_hba.conf"'   # compare with backup/pg_hba.pitr.conf
docker compose exec backup backup                                 # the first base backup, now
```

`compose.pitr.yaml` adds the volume, `archive_mode`/`archive_command`, a
`wal-init` helper (it makes the volume writable for `postgres`), and a
`pg_hba.conf` that also lets the backup service connect for base backups
(the replication protocol, password-protected, on the stack's network only).
**Compare that file with the running server's before relying on it**: it
replaces the image's. It repeats compose.prod.yaml's `postgres` command
(only `max_connections`): keep the two in step. WAL adds disk use: size the
volume for `archive_timeout`'s segments (16 MB each) times the days kept, or
more under write load, and watch `docker system df -v`.

**Restoring to a moment** replaces the whole cluster (every database, not one),
so it is the last resort after a dump restore isn't enough:

1. **Pick the moment** (UTC) just before the damage, and the newest base backup
   before it: `docker compose exec backup ls -l /backups | grep base-`. On a new host,
   fetch it first (`backup-fetch base-<time>.tar.gz[.age]`).
2. **Stop the stack:** `docker compose stop api worker postgres backup`.
3. **Keep the old data, prepare the new** (as root, with the PostgreSQL volume
   mounted; the recovered WAL goes beside the data, in the same volume):

   ```bash
   docker compose run --rm --no-deps --user root -v postgres_data:/var/lib/postgresql \
     -e BACKUP_DECRYPTION_KEY="$(cat backup.key)" --entrypoint sh backup -c '
       mv /var/lib/postgresql/18/docker /var/lib/postgresql/18/docker.before-pitr &&
       restore-pitr base-<time>.tar.gz.age --pgdata /var/lib/postgresql/18/docker \
         --wal-dir /var/lib/postgresql/pitr-wal --target-time "2026-10-21 09:30:00+00" --offsite'
   ```

   (Without encryption, drop the key and the `.age`; keep the key when the
   bucket's WAL is encrypted, even for a plaintext base backup taken before
   encryption was turned on. Without `--offsite`, the WAL comes from the
   `wal_archive` volume: add `-v wal_archive:/wal`.)
   `restore-pitr` unpacks the base backup, puts the WAL where the server
   reads it, and writes `restore_command`, `recovery_target_time` and
   `recovery.signal`.
4. **Start PostgreSQL:** `docker compose up -d postgres`. It replays the WAL up
   to the target (`docker compose logs postgres`: `recovery stopping before
   commit of transaction …`), then opens.
5. **Check the data, then start the app** (`docker compose up -d`) and take a
   base backup at once (`docker compose exec backup backup`): the recovered
   database runs on a new timeline, which older base backups don't follow.
   Remove `docker.before-pitr` and `pitr-wal` (in the volume) when all is well.

`recovery_target_action` is `promote`: a target after the last archived
segment, or none, replays everything and opens. A target earlier than the base
backup fails (use an older base backup).

**Try it** like a dump restore, now and then: `scripts/test-backup-pitr.sh`
runs the whole round trip (encrypted base backup and WAL, a target between two
writes, a plaintext base backup with encrypted WAL, an encrypted dump) against a throwaway PostgreSQL in the backup image; CI
runs it in `backup-image`.

### Restore drill

A backup nobody has restored is a hope. `scripts/restore-drill.sh` proves the
whole chain on a throwaway stack, with the same scripts and the same
procedure a real recovery uses (the load test's stack: `loadtest/run.sh`,
`compose.loadtest.yaml` on top, its own Compose project and generated
settings; the repository's `.env` is never read):

1. start the production stack and the `backup` service; sign in as the seeded
   administrator and write 12 notes;
2. stop `api` and `worker`, count the rows of **every table**, take a backup
   (`backup`, the scheduled run's own script);
3. destroy PostgreSQL's volume: a new, empty cluster;
4. `restore` the dump into it ([Restoring](#restoring)), then count again: the
   two lists must be identical;
5. start the stack (`migrate` grants the app role what the dump skipped), sign
   in again and read the notes back through the API;
6. report the durations and remove the stack.

It fails loudly at the first step that does not work (the stack's logs are
printed first) and when backup plus restore take longer than
`RESTORE_DRILL_MAX_SECONDS` (600). `RESTORE_DRILL_PROJECT` names the Compose
project (`loadtest-<name>` only: it removes the project's volumes),
`RESTORE_DRILL_KEEP=on` leaves the stack running, `APP_IMAGE` skips the build.
It needs Docker: `scripts/restore-drill.sh` locally, from the repository root.

**In CI** (`.github/workflows/restore-drill.yml`): weekly (Mondays 03:17 UTC),
on demand (`workflow_dispatch`), and on pull requests that touch `backup/`,
the drill or the load test's stack. The durations are in the job summary. A
failed run is the alert: GitHub mails the repository's watchers and the run
shows red.

**What it does not prove:** the off-host copy (no `BACKUP_S3_BUCKET` in a
throwaway stack: `backup-fetch` from your bucket needs your keys, so try it
by hand now and then), the uploaded files' archive (written, not extracted
and compared), or a restore of **your** data's size: the drill's database is
a few hundred rows, so its durations show the procedure works, not how long
yours takes. Time a restore of a real dump once and set
`RESTORE_DRILL_MAX_SECONDS` and your own expectations from that.

## CI

`.github/workflows/ci.yml` (per the pnpm CI guide) runs on every pull
request, on `main` and on `v*` tags. The checks are the root's scripts;
Turborepo's cache (`.turbo/cache`) is kept between runs. Each job fails the run,
except `openapi-diff`, which only reports until `OASDIFF_FAIL_ON` is set, and
`migration-lint` (`.github/workflows/migrations.yml`), whose destructive
statements are reported only until `MIGRATION_LINT_FAIL` is set (a changed
merged migration fails it already):

| Job                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                  | lint, build, `client:check`, `db:check`, migrations and the app role's bootstrap on a real PostgreSQL (twice: the second run changes nothing); lint and build are every package's (`turbo run`), the web app's included. The Caddy image, which carries the web app, is `caddy-image`'s |
| `changes`                | what a pull request touched (the API's file list), so `caddy-image` and `gotenberg-image` run on pull requests only for the paths they read; main, tags and the nightly run build both |
| `unit`                   | the unit tests beside `check`: the API's in 3 shards (`--shard=1/3`..`3/3`), the web app's in 3, the packages' in one job |
| `e2e`                    | the e2e tests in 6 shards (`--shard=1/6`..`6/6`), each on its own runner with PostgreSQL and Redis, beside `check`; every app runs as the app role, made by an owner that is no superuser ([Database roles](#database-roles)) |
| `e2e-web` | the web app's browser tests (`pnpm test:e2e:web`, Playwright on the built API and web app, with an axe accessibility scan), with its own PostgreSQL and Redis; not a dependency of `publish` (development.md, "Browser tests") |
| `compose-secrets`        | the production stack's secrets with the values in `.env` and with every one in a file, as Compose renders them (the monitoring stack too); then the shell readers in their images (`scripts/test-secret-readers.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `swarm-stack`            | `compose.swarm.yaml` rendered with dummy values and accepted by `docker stack config` (`pnpm deploy:swarm check`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `feature-smoke`          | the feature generator's tests, then two features generated with every option, which must build, lint, migrate and pass their generated e2e tests ([adding a feature](adding-a-feature.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `e2e-telemetry` | one shard of the e2e suite (`--shard=1/6`) with OpenTelemetry and Sentry on, against a stub collector (`apps/api/test/telemetry-stub.mjs`), then the built app (`node dist/main`) against one of its own; fails if the instrumentation breaks the app or no span of a request served arrives ([Telemetry](#telemetry)) |
| `template-without-notes` | `pnpm feature:remove notes` (the API's and the web app's part), no `notes` left in `apps/api` or `apps/web`, then lint, build, `db:check`, `client:generate` and the build again on that client: the core and the web app stand without the example. On main, tags and the nightly run (03:17 UTC) also its unit and web tests and the whole e2e suite, in 6 shards like the `e2e` job's (each runs a sixth of the e2e suite and a third of the API's or the web app's unit tests), so the run lasts as long as a pull request's; a pull request skips those (they are the `unit` and `e2e` jobs' tests with a feature fewer) |
| `security`               | `pnpm audit --prod --audit-level high`; Trivy: any secret in the repository, high or critical misconfigurations in the Dockerfiles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `image`                  | builds the production image; Trivy: fixable high or critical vulnerabilities in it (OS packages and `node_modules`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `backup-image`           | builds the backup image (`backup/`); the same Trivy scan. Not published: a deploy builds it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `caddy-image`            | builds Caddy's image (`caddy/Dockerfile`, from the repository root): the web app's production build and the xcaddy build with the Cloudflare plugin; checks the web app is in it, then the same Trivy scan. Published by `publish-caddy`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `gotenberg-image`        | checks that `gotenberg/Dockerfile`'s `FROM`, its `GOTENBERG_VERSION` and `compose.dev.yaml`'s image are one release, and that both Compose files give Gotenberg the same flags; builds the image (`gotenberg/`, its Debian upgrade fresh each run) and runs the same Trivy scan                                                                                                                                                                                                                                                                                                                                                                                   |
| `openapi-diff`           | pull requests only: oasdiff compares the typed client's `openapi.json` with the base branch's and lists breaking changes and the changelog in the job summary. Report-only until `OASDIFF_FAIL_ON` is set (development.md, "Typed client")                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `migration-lint`         | pull requests only, in `migrations.yml` (adding or removing the `destructive-migration` label runs it again; other labels skip it): squawk reads the migrations the pull request adds under `apps/api/drizzle/` and lists destructive statements (drops, renames, retypes, `SET NOT NULL`, NOT NULL without a default, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`, `MERGE`'s deletes and updates) in the job summary, with file and line. Report-only until `MIGRATION_LINT_FAIL` is `on` (pitfalls.md, "Migrations: expand/contract"). Always failing: an edited or deleted merged migration or journal entry, a `squawk-ignore` comment. The `destructive-migration` label accepts both when added after the latest push |
| `publish`                | `main` and `v*` tags only, after `check`, `e2e`, `security` and `image`: pushes the app image to GHCR (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `publish-gotenberg`      | the same for Gotenberg's image, after `gotenberg-image` too: `ghcr.io/<owner>/<repo>/gotenberg`, the build `gotenberg-image` scanned in the same run, scanned again, then pushed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `publish-caddy`          | the same for Caddy's image, after `caddy-image`: `ghcr.io/<owner>/<repo>/caddy`, the build `caddy-image` scanned in the same run (its `scope=caddy` cache), scanned again, then pushed                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `release`                | `v*` tags only, after the three publish jobs: the tag's GitHub release, its notes generated by `tools/release/notes.mjs` (the images by version and digest, the migrations since the previous release and the expand/contract lint's findings, rolling back; [releases](releases.md)). Its tests run in `check`                                                                                                                                                                                                                                                                                                                                                   |

- **The same PostgreSQL and Redis as Compose:** CI reads their images from
  `compose.yaml` (job `compose-images`). Change them there only.
- **Load test:** `.github/workflows/load-test.yml`, manual only for now
  (`workflow_dispatch`, to save Actions minutes; a pull request changing the
  load test runs it report-only): the production stack and k6 on a GitHub
  runner, failing only on a 2× regression against the previous run or the
  anchor (the k6 scenarios and the Artillery socket.io run; two api
  replicas, the bot check off: `LOADTEST_REPLICAS` and `LOADTEST_CAPTCHA`
  are for manual runs). A schedule comes back with one line under `on:`, e.g.
  `schedule: [{ cron: '37 2 * * 1' }]` (development.md, "Load tests").
- **Devcontainer:** `.github/workflows/devcontainer.yml` builds
  `.devcontainer/` with the pinned `@devcontainers/cli` (`devcontainer up`,
  so `post-create.sh` and `pnpm install`) and smoke-tests it: `pnpm dev`,
  then `127.0.0.1:5173/`, `[::1]:5173/` and `/health` through Vite's proxy
  must answer 2xx (`.devcontainer/smoke-test.sh`). Runs on pull requests
  and `main` that change `.devcontainer/**`, `compose.yaml`,
  `compose.dev.yaml`, `apps/web/vite.config.ts`, `pnpm-lock.yaml` or the
  workflow, and on demand. Not a required check (development.md,
  "Devcontainer").
- **Commit messages:** `.github/workflows/commit-messages.yml` fails a pull
  request whose title, or whose only commit's subject, isn't a Conventional
  Commit (development.md, "Git hooks").
- **Typed client:** `.github/workflows/api-client.yml` reports a pull
  request that changes `packages/api-client` without a changeset, and on
  `main` opens the client's version pull request; its npm publish is off
  until the owner turns it on ([releases](releases.md), "The typed client").
- **GitHub code scanning:** the repository is public, CodeQL's default setup
  analyses every pull request and `main`, and the `main` ruleset requires its
  result. The other scans print their findings in the job's log.
- **A finding that doesn't apply:** add it to `.trivyignore.yaml` with a
  `statement` saying why (as for Caddy running as root). For an npm
  advisory, `pnpm audit --ignore <GHSA id>` in the workflow, with a comment.
  Prefer a fix: a newer package or base image.
- **Run the scans locally:**
  `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.76.0 image --severity HIGH,CRITICAL --ignore-unfixed <image>`.
- **Versions:** Dependabot proposes newer packages, images and actions as
  pull requests (pinned versions, never `:latest`). `@types/node` follows
  the Node.js major the app runs on, so Dependabot skips its major
  versions: raise it together with `devEngines.runtime`, apps/api/Dockerfile's
  `node` image and CI's `runtime`. Trivy's own version (`version:` in the
  workflow), oasdiff's (`OASDIFF_IMAGE`) and squawk's (`SQUAWK_IMAGE` in
  `tools/migration-lint/lint.mjs`; its tests run in the job) and k6's
  (`K6_IMAGE` in `loadtest/run.sh`) are raised by hand.

## The image

`apps/api/Dockerfile`, built from the repository root (the workspace's
lockfile and packages are part of it; the root's `.dockerignore` keeps the
rest out). `pnpm deploy` gives the image the API's production dependencies
only: `/app` holds `package.json`, `dist/`, `drizzle/` and `node_modules/`,
as before the monorepo, so `node dist/main`, `dist/worker` and
`dist/migrate` are unchanged. By hand: `docker build -f apps/api/Dockerfile .`
Compose sets `NODE_ENV=production` for the containers; a bare `node
dist/main` outside it must set it too, since what refuses development-only
settings in production (the captcha stub, text logs) reads it.

## Publishing and rolling back images

On every push to `main` and every `v*` tag, CI pushes the production image
to `ghcr.io/<owner>/<repo>` (here `ghcr.io/lamberto15/nestjs-monorepo-template`).
It builds it once, scans it, and pushes it only when every check passed.

- **Tags:** the full commit SHA, always; `main` for a push to main; `1.2.3`
  and `1.2` for a `v1.2.3` tag. Never `latest`: a deploy names the image
  it runs. A `v1.2.3` tag also gets a GitHub release whose notes name both
  images by version and digest, list the migrations since the previous
  release, and say how to roll back to it ([releases](releases.md)).
- **Caddy's image** (job `publish-caddy`) is published the same way, to
  `ghcr.io/<owner>/<repo>/caddy` with the same tags. It carries Caddy with the
  Cloudflare DNS plugin (pinned, `caddy/Dockerfile`) and the web app
  (`apps/web`, built into `/srv/web`), and nothing of one deployment: the
  domain, the ACME email and the Cloudflare token come from the environment
  at run time (`Caddyfile`), the web app has no build-time variables and
  calls the API on its own origin, and the Turnstile site key comes from the
  API. So one published image serves every deployment, and its tag pins a web
  build to the API build of the same commit: deploy `APP_IMAGE` and
  `CADDY_IMAGE` at the same SHA.
- **Inside:** `GIT_SHA` is the commit (NestJS Observe reports it as the
  version), and the OCI labels name the repository, commit and build time.
- **Private:** the package belongs to the repository and follows its
  access. Pulling needs a login (below).

Logging in once on the host, with a classic personal access token that has
`read:packages` (GitHub Packages doesn't take fine-grained tokens):

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github user> --password-stdin
```

Deploying a published image: set `APP_IMAGE` (and `GOTENBERG_IMAGE` and
`CADDY_IMAGE`, Gotenberg's and Caddy's from the same commit) in `.env`, then pull and start. Without
`--build`: a build would replace the pulled images with local ones.

```bash
# .env
APP_IMAGE=ghcr.io/lamberto15/nestjs-monorepo-template:<full commit SHA>
GOTENBERG_IMAGE=ghcr.io/lamberto15/nestjs-monorepo-template/gotenberg:<full commit SHA>
CADDY_IMAGE=ghcr.io/lamberto15/nestjs-monorepo-template/caddy:<full commit SHA>

docker compose pull migrate api worker gotenberg caddy
docker compose up -d --remove-orphans
```

Rolling back: set `APP_IMAGE` (and `GOTENBERG_IMAGE`, `CADDY_IMAGE`) to the previous commit's SHA, then the same
two commands. `git log --format=%H main` lists the SHAs; the package's page
on GitHub lists the published ones. The Compose files must fit the image:
when a release changed them, check them out at that SHA too (`git checkout
<SHA> -- compose.yaml compose.prod.yaml`), and read the release's notes for
what else it needs. The database roles release (roadmap 1a) is one: its
previous image needs `DATABASE_URL` to be the owner's ([Database
roles](#database-roles), "Rolling back past this release").

- **Migrations don't roll back.** The older image runs on the newer schema,
  so a release's migrations only add (columns, tables) and leave dropping,
  renaming and retyping to a later release: expand/contract
  ([pitfalls](pitfalls.md), "Migrations: expand/contract"), which CI's
  `migration-lint` checks.
- **Unset `CADDY_IMAGE`** builds Caddy and the web app on the host
  (`docker compose up -d --build caddy`), as before.
- **Unset `APP_IMAGE`** (or leave it out): `docker compose up -d --build`
  builds from the checkout, as before.

### Signing and verifying images

Each publish job (app, Gotenberg, Caddy) signs what it pushed, by digest, with
the composite action `.github/actions/sign-image`:

- **Signature:** `cosign sign`, keyless (GitHub OIDC: no key to keep). The
  certificate names the workflow that signed, `ci.yml` on `main` or a `v*`
  tag, and is logged in the public Rekor log.
- **Provenance:** a SLSA build provenance attestation
  (`actions/attest-build-provenance`), pushed to the registry next to the
  image and listed under the repository's Attestations.
- **SBOM:** a CycloneDX SBOM of the pushed image (Trivy, which CI already
  installs), signed as an attestation (`cosign attest --type cyclonedx`).

Only the publishing jobs get `id-token: write` and `attestations: write`;
every other job keeps read-only permissions. Signatures and attestations are
stored as extra tags in the same package (`sha256-<digest>.sig`, `.att`).

Verify before pulling (needs [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
and, for provenance, the `gh` CLI):

```bash
scripts/verify-image.sh                # APP_IMAGE, GOTENBERG_IMAGE, CADDY_IMAGE
scripts/verify-image.sh ghcr.io/<owner>/<repo>:<full commit SHA>

# what it runs, per image:
cosign verify <image> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/<owner>/<repo>/\.github/workflows/ci\.yml@refs/(heads/main|tags/v.+)$'
cosign verify-attestation <image> --type cyclonedx  # same two flags
gh attestation verify oci://<image> --owner <owner>
```

Set `VERIFY_IDENTITY_REGEXP` to accept a different signer (a fork's workflow, say). A failure exits
non-zero and prints cosign's reason; do not deploy that image.

**In the deploy scripts:** `VERIFY_IMAGES=1` makes `pnpm deploy:rolling`
(before it pulls `APP_IMAGE`), `deploy:blue-green` (with `--image`) and
`deploy:swarm deploy` run the script first and stop when it fails. Off by
default, because it needs cosign on the deploy host; the plain
`docker compose pull` path above is unchanged.
