# Deployment

## Production with Docker Compose

```bash
pnpm run setup --target production          # asks, writes .env (chmod 600), every secret generated
# or by hand:
cp env.example .env && chmod 600 .env   # then fill it (below)
pnpm env:check                    # names missing from .env, REQUIRED ones empty (exits 1)
docker compose up -d --build      # .env sets COMPOSE_FILE=compose.yaml:compose.prod.yaml
docker compose ps
```

`pnpm env:check` compares `.env` with `env.example` by name, and reads nothing
else: Compose has defaults for most variables, so `docker compose config`
passes with a stale `.env` and the app then runs with values you never saw.
Run it before every `docker compose up` that follows an update of the
template; a re-run of `pnpm run setup --target production` adds the missing
variables with the template's defaults
([configuration.md](configuration.md#first-setup-pnpm-run-setup)).

Filling `.env` (each step is commented in `env.example`):

- **Required:** `APP_DOMAIN` and `ACME_EMAIL` (Compose stops without them),
  `CLOUDFLARE_API_TOKEN` (Caddy stops without it), `POSTGRES_PASSWORD` and
  `POSTGRES_APP_PASSWORD` (`openssl rand -hex 24` each: hex, since they go
  into `DATABASE_OWNER_URL` and `DATABASE_URL`; without them, `migrate` stops
  on the missing URL; the two roles: [Database roles](#database-roles)). The
  secrets can be files instead: [Secrets in files](#secrets-in-files).
- **Recommended:** `REDIS_PASSWORD` (`openssl rand -hex 24`) and
  `WEBHOOKS_ENCRYPTION_KEYS` (`openssl rand -base64 32`; unset, webhook
  endpoint secrets are stored unencrypted).
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
  `/v1/*`, `/socket.io/*`, `/health` and `/health/*`, `/api` and `/api/*` (Swagger UI),
  `/api-json`, `/api-yaml`, `/files` and `/files/*` (the local disk's links are
  `/files?key=…`, the path `/files` itself) and `/.well-known/*` to the API, `/metrics*`
  to a 404, and every other path to the app
  (`index.html` for its routes; `/assets/*` cached for a year, `index.html` never). The
  API's routes are the app's origin, so `__Host-sid` works and no CORS is needed. A new
  API path (an unversioned one, or a new version prefix such as `/v2/*`) needs a line in
  the `@api` matcher, with the bare path when the API serves it, and in the lists that
  mirror it: `apps/web/pwa-paths.ts` and the dev proxy (`apps/web/dev-proxy.ts`) if the web app calls it. A web
  change redeploys Caddy (`docker compose up -d --build`); a change to the Caddyfile alone
  is read when Caddy starts (a bind mount: Compose sees no change), so
  `docker compose up -d --force-recreate caddy`.
- **The web app's security headers** are set in the Caddyfile's web-app `handle` only
  (the API's responses keep helmet's own): `Content-Security-Policy`
  (`default-src 'self'`; scripts and frames also from `https://challenges.cloudflare.com`,
  Turnstile's only needs; `connect-src 'self'` covers the API and socket.io;
  `img-src 'self' data: blob:` (`blob:` is the queued-upload preview, `packages/ui`'s
  `FileUpload`: the browser's own object URL for a file not yet sent, never a network
  request); both also name the origins of files, below; `style-src` keeps `'unsafe-inline'` because sonner and the theme
  provider inject `<style>` elements; no `'unsafe-eval'`, so `apps/web` imports `z` from `@/lib/zod`, which sets zod to
  `jitless`; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options`,
  `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` that turns
  off everything but WebAuthn, `Strict-Transport-Security` (`max-age=63072000;
  includeSubDomains`, matching the API's own: this deployment serves every subdomain
  under `APP_DOMAIN` over HTTPS only; no `preload`, which submits the domain to browsers'
  built-in list, a step this template doesn't take for the owner)
  and `Cross-Origin-Opener-Policy: same-origin`. **A new third-party script, frame, API or
  font host** needs its origin in the matching directive of that one line (`script-src`,
  `frame-src`, `connect-src`, `font-src`, `img-src`), taken from the provider's CSP page; no
  inline `<script>`, no `eval`. `caddy/caddyfile.test.mjs` pins the full header set
  against a real Caddy binary, on the app shell, an asset and the maintenance page; that is the
  one place a change to this line is checked (the e2e suite stopped sending it under
  `vite preview` when `apps/web/preview-headers.ts` was removed with the browser
  analytics feature it also served).
- **Compression.** Caddy's image build writes a `.br` and a `.gz` beside each built
  asset (`apps/web/scripts/precompress.mjs`, Node's `zlib`), served with
  `file_server { precompressed br gzip }`; the app shell and the rest of the response
  (`index.html`, `version.json`, the service worker, the manifest, the maintenance page)
  are encoded per request (`encode zstd gzip`). The `/v1/*` proxy stays unencoded: Caddy's
  `encode` would suffix the API's strong ETags (`"<hash>-gzip"`) and strip that suffix
  only from a read's `If-None-Match`, not from a write's `If-Match`, which would then
  succeed only because `etag.ts` happens to trim long tags to their hash. Compressing the
  API, if wanted, is a separate decision (in Nest, or at the edge) for each deployment.
  The ops event stream (`GET /v1/ops/events`) is never buffered or encoded, so it still
  flushes each event as it is written.
- **The origins of files** (`STORAGE_DRIVER=s3`). The browser reaches the bucket itself
  twice: it PUTs a direct upload straight to it
  ([attachments](attachments.md#direct-uploads-s3)), and the attachments panel's `<img>`
  for an image's thumbnail and preview
  (`GET /v1/attachments/{id}/download?rendition=thumb|preview`) follows a 302 to the
  bucket's signed link ([attachments](attachments.md#image-renditions)). The policy
  blocks a request to an origin it does not name before any CORS check (the web app
  still works without it, less directly: uploads go through the API, a thumbnail that
  cannot load shows the file icon, and the original still downloads, a download being a
  navigation, which neither directive governs). With `STORAGE_DRIVER=local` there is
  nothing to add: the files' links are `https://<APP_DOMAIN>/files…`, the app's own
  origin (`/files` goes to the API above), which `'self'` covers. So `connect-src` and
  `img-src` both name one list of origins, which `caddy/entrypoint.sh` makes at each
  start (`WEB_FILES_ORIGINS`, the one value the Caddyfile reads for them; after changing
  the settings, recreate Caddy: `docker compose up -d caddy`). The list holds:
  - **the bucket's origin**, derived from the app's own `S3_BUCKET`, `S3_ENDPOINT`,
    `S3_REGION` (or `AWS_REGION`) and `S3_FORCE_PATH_STYLE` as the API's S3 disk signs its
    URLs (`https://<bucket>.s3.<region>.amazonaws.com`; R2's
    `https://<bucket>.<account>.r2.cloudflarestorage.com`; with path style, the endpoint
    with the bucket's path, `https://s3.<region>.amazonaws.com/<bucket>/`, never the
    bare host, which on AWS and other shared stores serves every customer's buckets;
    the upload's `PUT` matches the path, and a source's path does not count after a
    redirect, so the thumbnail's 302 still loads), which `compose.prod.yaml` hands to
    `caddy`. Settings it cannot make an origin of leave it out, with a warning in
    Caddy's log;
  - then **`FILES_ORIGIN`**, set in `.env`: space-separated `https://host[:port]` origins
    the settings can't tell, such as a custom domain or a CDN in front of the bucket.
    Empty (the default), nothing is added. It goes into the policy as written, so
    `caddy/entrypoint.sh` refuses to start with anything else (a path, a wildcard, a
    quote or a semicolon).
- **Security contact** (`/.well-known/security.txt`, RFC 9116). Caddy answers that one
  path itself (its handle comes before the `@api` matcher); `caddy/entrypoint.sh` writes
  the file to `/tmp/caddy-security` at each start from `SECURITY_CONTACT` (one or more
  `mailto:`/`https:` URIs, comma-separated; the RFC requires it, and unset means no file,
  a 404), `SECURITY_EXPIRES` (RFC 3339 UTC; unset, a year from the start, so pin it to
  keep one date), `SECURITY_POLICY` (the `SECURITY.md` URL; the default is this template's
  on GitHub, so set your own) and `SECURITY_PREFERRED_LANGUAGES` (`en`). Check it after a
  deploy: `curl -i https://<APP_DOMAIN>/.well-known/security.txt`.
- **Maintenance page** (`MAINTENANCE_PAGE=on`). Maintenance and read-only mode
  ([settings](settings.md), "Maintenance and read-only mode") stops the API taking
  requests, but the web app's files are still Caddy's to serve. With the flag on,
  every path of the web app (`/`, its routes, `/assets/*`, the manifest) answers the
  static `caddy/maintenance.html` instead: status 503, `Retry-After: 30`,
  `Cache-Control: no-store` and the web app's security headers, so not even the shell
  is served. The page has no script and makes no request; it carries the five
  languages and reloads itself every 30 seconds, so it turns into the app when the
  flag goes off. Nothing else changes: the API's paths (`@api` below), `/metrics`
  (404) and `security.txt` answer as before, so a client or a probe still sees the
  API's own 503 `maintenance`. Caddyfile: a `handle @maintenance` first in the web
  app's block, a `file_server { status 503 }` on a rewrite to the page, the flag read
  as `{env.MAINTENANCE_PAGE}` at each request ([Caddyfile
  concepts](https://caddyserver.com/docs/caddyfile/concepts#environment-variables),
  the `expression` matcher). Exactly `on` turns it on; unset or anything else is off.
  - **Planned maintenance:** set `APP_MODE=maintenance` and `MAINTENANCE_PAGE=on` in
    `.env` and `docker compose up -d` (it recreates `api`, `worker` and `caddy`; a
    flag changed alone: `docker compose up -d caddy`, a few seconds without the web
    app). To end it, remove both and run it again. The two are separate on
    purpose: the page alone is for when the API is gone altogether (a restore), the
    mode alone keeps the web app up and shows its notice. An operator can end only a
    mode set by the `platform.mode` setting from that notice; one forced by `APP_MODE`
    (as here) ends when it is removed from `.env`.
  - **An installed web app** (the service worker) still opens its cached shell, and
    then shows its own notice: the API answers 503 `maintenance`, which the app turns
    into a full-page notice ([monorepo](monorepo.md), "Maintenance and read-only
    mode"). Only first visits and other clients see Caddy's page.
  - **Test:** `CADDY_BIN=/path/to/caddy node --test caddy/caddyfile.test.mjs` runs
    the real Caddyfile (the TLS block and Docker names edited out) under a real Caddy;
    CI's `caddy-image` job runs it with the image's own binary.
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

- **Resource limits** on every service (`API_CPUS`, `API_MEMORY`,
  `WORKER_CPUS`, `WORKER_MEMORY`, `POSTGRES_*`, `REDIS_*`): none can starve the
  others. The Node heap (`API_HEAP_MB`, `WORKER_HEAP_MB`) and Redis'
  `maxmemory` stay below their limits. Limits don't add capacity: keep their
  sum within the host's. See [Resource limits](#resource-limits) for how
  the app's are sized.
- The API is reachable only through Caddy (port 3000 isn't published): the
  Secure cookie and `trust proxy` rely on that.
- Local file storage is a volume shared by the replicas of one host. More hosts:
  `STORAGE_DRIVER=s3`.
  With S3 the web app uploads straight to the bucket (presigned PUT): the
  bucket needs a CORS rule for the web app's origin
  ([attachments](attachments.md#direct-uploads-s3)); without one it uploads
  through the API instead.
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

### Redeploying without downtime

`docker compose up -d --build` recreates both `api` replicas at once, and a
replica answers only after it boots (the image's health check starts after
30 s; Node needs 30-60 s with the migrations done). Compose has no rolling
update, so for that window no replica is up. What the stack does about it:

- **Caddy holds the request** (`lb_try_duration 30s`, `lb_try_interval 250ms`
  in `caddy/Caddyfile`): with no healthy upstream
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
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `POSTGRES_PASSWORD_FILE`                                                                                                                                                                                                                                                                                                                                                                      | PostgreSQL (the image itself, when it creates the database)                                                             | `POSTGRES_PASSWORD`                                 |
| `POSTGRES_MONITOR_PASSWORD_FILE`                                                                                                                                                                                                                                                                                                                                                              | `migrate` (creates the monitoring role with it)                                     | `POSTGRES_MONITOR_PASSWORD`                         |
| `DATABASE_OWNER_URL_FILE`                                                                                                                                                                                                                                                                                                                                                                     | `migrate` only (the owner's URL with that password: `postgres://app:<password>@postgres:5432/app`); the secret is mounted on no other service         | the URL Compose builds from `POSTGRES_PASSWORD`     |
| `DATABASE_URL_FILE`                                                                                                                                                                                                                                                                                                                                                                           | the app (api, worker) and `migrate` (the app role's URL: `postgres://app_runtime:<password>@postgres:5432/app`, with `POSTGRES_APP_PASSWORD`'s value) | the URL Compose builds from `POSTGRES_APP_PASSWORD` |
| `REDIS_PASSWORD_FILE`                                                                                                                                                                                                                                                                                                                                                                         | Redis and its healthcheck (`redis/redis.sh`), and the app (`REDIS_PASSWORD`): one file                                            | `REDIS_PASSWORD`                                    |
| `DATABASE_MAINTENANCE_URL_FILE` | `migrate` (creates the role) and `worker` (the maintenance role's URL: `postgres://app_maintenance:<password>@postgres:5432/app`) | the URL Compose builds from `POSTGRES_MAINTENANCE_PASSWORD` |
| `POSTGRES_REPORTING_PASSWORD_FILE` | `migrate` only (creates the reporting role with it) | `POSTGRES_REPORTING_PASSWORD` |
| `CLOUDFLARE_API_TOKEN_FILE`                                                                                                                                                                                                                                                                                                                                                                   | Caddy (`caddy/entrypoint.sh`)                                                                                                                         | `CLOUDFLARE_API_TOKEN`                              |
| `SMTP_URL_FILE`                                                                                                                                                                                                                                                                                                                                                                               | the app, and Alertmanager (its default `ALERT_SMTP_URL`)                                                                                              | `SMTP_URL`                                          |
| `ANTHROPIC_API_KEY_FILE` | the app (api, worker; not `migrate`) | `ANTHROPIC_API_KEY` |
| `POSTMARK_WEBHOOK_SECRET_FILE` | the app (api, worker; not `migrate`) | `POSTMARK_WEBHOOK_SECRET` |
| `RESEND_WEBHOOK_SECRET_FILE` | the app (api, worker; not `migrate`) | `RESEND_WEBHOOK_SECRET` |
| `TWILIO_AUTH_TOKEN_FILE` | the app (api, worker; not `migrate`) | `TWILIO_AUTH_TOKEN` |
| `WEB_PUSH_VAPID_PRIVATE_KEY_FILE` | the app (api, worker; not `migrate`) | `WEB_PUSH_VAPID_PRIVATE_KEY` |
| `APNS_PRIVATE_KEY_FILE` | the app (api, worker; not `migrate`) | `APNS_PRIVATE_KEY` |
| `FCM_PRIVATE_KEY_FILE` | the app (api, worker; not `migrate`) | `FCM_PRIVATE_KEY` |
| `SENTRY_DSN_FILE` | the app (api, worker; not `migrate`) | `SENTRY_DSN` |
| `OTEL_EXPORTER_OTLP_HEADERS_FILE` | the app (api, worker; not `migrate`) | `OTEL_EXPORTER_OTLP_HEADERS` |
| `JWT_SECRET_FILE`, `MFA_ENCRYPTION_KEYS_FILE`, `STORAGE_SIGNING_KEYS_FILE`, `IDEMPOTENCY_KEYS_FILE`, `CURSOR_KEYS_FILE`, `WEBHOOKS_ENCRYPTION_KEYS_FILE`, `DATA_ENCRYPTION_KEYS_FILE`, `BLIND_INDEX_KEYS_FILE`, `ADMIN_PASSWORD_FILE`, `MAIL_API_KEY_FILE`, `AWS_SECRET_ACCESS_KEY_FILE`, `GOOGLE_CLIENT_SECRET_FILE`, `MICROSOFT_CLIENT_SECRET_FILE`, `GITHUB_CLIENT_SECRET_FILE`, `TURNSTILE_SECRET_KEY_FILE`, `PLAY_INTEGRITY_DECRYPTION_KEY_FILE`, `OBSERVE_APP_SECRET_FILE`, `EXAMPLE_SENDER_WEBHOOK_SECRET_FILE` | the app (api, worker; not `migrate`)                                                                                                                  | the variable without `_FILE`                        |

Not in this list, so they stay variables in Compose:

- `METRICS_TOKEN`.
- `AWS_SESSION_TOKEN`: a temporary credential, which a file mounted at deploy time can't renew.
- `OBSERVE_APP_KEY`.
- `POSTGRES_APP_PASSWORD`: it only builds `DATABASE_URL`, and the whole URL
  is the secret (`DATABASE_URL_FILE`); a file for the password alone would
  still have to be read into a URL by Compose, in a variable.

The app reads a `_FILE` for every secret (configuration.md, "Secrets"), so
outside Compose all of these work as files too.

In `.env`, `X_FILE` is the file's absolute path on the host. Compose hands
the containers `X_FILE=/run/secrets/x`.

- **The file or the variable, never both.** The app, Redis, Caddy
  and PostgreSQL's image each refuse to start when both are set.
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
  `POSTGRES_PASSWORD_FILE` (PostgreSQL) and
  `DATABASE_OWNER_URL_FILE` (`migrate`). Then set `POSTGRES_PASSWORD=` empty
  and recreate `migrate`. **The monitoring role's** moves to
  `POSTGRES_MONITOR_PASSWORD_FILE` (`migrate` reads it); set
  `POSTGRES_MONITOR_PASSWORD=` empty, recreate `migrate`. PostgreSQL reads
  its file only when it creates a database: a running one already has its
  password.
- **The app role's password** moves to `DATABASE_URL_FILE` (the whole URL,
  `postgres://app_runtime:<password>@postgres:5432/app`). Then set
  `POSTGRES_APP_PASSWORD=` empty and recreate `migrate api worker`.
- **Redis' password** moves to `REDIS_PASSWORD_FILE`. Set `REDIS_PASSWORD=`
  empty, then recreate `redis api worker`.
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

### Custom domains (on-demand TLS)

With `CUSTOM_DOMAINS=on` ([branding](branding.md#custom-domains)), a tenant
adds a hostname of its own (`tenant.example.com` here: a placeholder; real
hostnames never go in the repository), points it at the deployment with a
CNAME to `APP_DOMAIN`, and proves it with a TXT record. Caddy serves it from
the Caddyfile's last site, `https://`, every hostname `APP_DOMAIN` isn't:

- **Certificates on demand.** The first TLS handshake for a hostname asks
  the API (the global `on_demand_tls`, `ask
  http://api:3000/v1/internal/domains/allowed?domain=<hostname>`): 200 for a
  verified domain of an active tenant, else 404 and the handshake fails, so
  nobody can make Caddy request certificates for names of their choosing.
  The certificate comes by HTTP-01 or TLS-ALPN-01 (the tenant's zone is not
  in your Cloudflare account): ports 80 and 443 must reach Caddy. Caddy keeps
  them in its `caddy_data` volume with the app's own, and renews them,
  asking the API again; the ACME CA's rate limits apply per hostname.
- **Checked per request.** The site's `forward_auth` asks the API the same
  question before every request, so a domain removed or suspended (its TXT
  record gone, the nightly check) stops serving at once, though its
  certificate is still cached: Caddy answers the API's 404 as it is.
- **Rate limited.** The API counts the question per address (600 a minute,
  then 429, which fails the handshake or the request): the TLS asks against
  Caddy's address, the per-request checks against the visitor's. Unknown
  hostnames are remembered for 30 s, so a flood of made-up names (TLS
  handshakes with random SNI) reads the database at most that often per
  name, and never more than the limit allows.
- **The question stays inside.** `/v1/internal/*` answers 404 on every site
  from outside; Caddy reaches the API on the Compose network. The answer only
  says whether a hostname is a verified custom domain, which its TXT record
  and its pages already say.
- **Off** (the default): the API answers 404 to every hostname; no
  certificate is ever issued for anything but `APP_DOMAIN`.

### Gotenberg (PDF documents)

The workers render [documents](documents.md) with
[Gotenberg](https://gotenberg.dev), which the stack does not run: documents
are off (503 `documents_unavailable`) until `GOTENBERG_URL` names one you
run. Keep Chromium out of the worker's image and off the public network: a
container of its own, reachable by the workers only, started with
`--chromium-allow-list=^file:///tmp/`, `--chromium-deny-private-ips`,
`--chromium-deny-public-ips`, `--chromium-disable-javascript`,
`--api-disable-download-from` and `--webhook-disable`, and an
`--api-timeout` longer than the app's `GOTENBERG_TIMEOUT_MS` (30 s).

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
  while converting gets the job back once (BullMQ's stalled-job check);
  killed on it again, the image ends `failed`, as uploaded, so one image
  can't take the worker down over and over.
- **The heavy worker** ([background work](background-work.md#splitting-the-workers)):
  imports, exports, PDFs and attachment processing in `worker-heavy`, one job
  per queue, so their peaks never meet mail's or the outbox's:

  ```text
  worker-heavy: 1536 MiB ≥ 1024 (HEAVY_WORKER_HEAP_MB) + 512 outside the heap
  ```

  The 512 MiB covers an image's libvips buffers (~264 MiB at the defaults
  above), a workbook read whole and the sockets. The streamed imports keep
  under 1 MB per job (`formats.memory.spec.ts`); the heavy worker's
  limit is 1536 MiB.
  sharp brings libvips prebuilt (the `@img/sharp-*` package for the platform
  and libc, an optional dependency with no install script): the glibc image
  (`apps/api/Dockerfile`) needs no extra package and no `allowBuilds` entry.

### Container hardening

Every service of compose.prod.yaml
runs with `read_only: true`, `cap_drop: [ALL]` and `no-new-privileges`, and a
`tmpfs` for what it writes. A compromised
process then can't change the image, plant a binary, or gain privileges.
What each one may write, and the capabilities it gets back:

| Service | Writable (besides the image: none) | Capabilities added back |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api`, `worker`, `migrate` | `/tmp` (64m tmpfs); `api` and `worker` also the `app_storage` volume | none |
| `postgres` | the `postgres_data` volume, `/tmp` (64m) and `/run/postgresql` (the socket) in memory | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`: the image's entrypoint starts as root, fixes the data directory and drops to `postgres` |
| `redis` | the `redis_data` volume, `/tmp` (16m) | `DAC_OVERRIDE`: the command is `sh redis.sh`, not `redis-server`, so the image's entrypoint never drops to `redis`; the server runs as root on a volume that is `redis`'s, which root can't write without it |
| `caddy` | the `caddy_data` and `caddy_config` volumes, `/tmp` (16m, including generated `security.txt`) | none: UID/GID `10001:10001`; low ports allowed only in its network namespace |

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
- **Not covered:** `compose.yaml` / `compose.dev.yaml` alone (development).
- **CI** (`.github/workflows/ci.yml`): `stack-config` renders `compose.yaml` +
  `compose.prod.yaml` with every profile on and fails when a service lacks
  the keys (`read_only`, `cap_drop`, `no-new-privileges`, a `/tmp` tmpfs),
  whichever service it is. The exceptions are a list in that step, by
  service and key (none today). CI does not start the stack: start it once
  yourself after changing a service (`docker compose up -d`, then
  `docker compose ps` and the logs).

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
  recovery; drop `postgres` from the stack.
- **Read replicas:** not built in ([Read replicas](#read-replicas)).
- **Redis:** managed, or Sentinel (`REDIS_SENTINELS=host:26379,…`,
  `REDIS_SENTINEL_NAME`); drop `redis` from the stack.
- **Files:** S3 or R2 (`STORAGE_DRIVER=s3`, `S3_*`).
- **Hosts:** an orchestrator (a managed platform, Kubernetes, Swarm) runs the
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
make. For more reads before that: a connection pooler such as PgBouncer,
indexes (`EXPLAIN` the slow list), a larger primary.

## Database roles

Two roles share the database ([roadmap](roadmap.md), 1a), so that row-level
security can mean something: PostgreSQL skips it for superusers and for a
table's owner, and the postgres image's `POSTGRES_USER` is both.

| Role            | Who                                                                             | Connects as                                                                                                                        | Gets                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **owner**       | `migrate`; the app itself when `MIGRATE_ON_START` is on (development)           | `DATABASE_OWNER_URL` (Compose: `POSTGRES_USER`, default `app`, the image's superuser)                                              | owns every schema, table and sequence; runs the migrations                                                                                                                                                                                                 |
| **app**         | `api`, `worker`                                                                 | `DATABASE_URL` (Compose: `POSTGRES_APP_USER`, default `app_runtime`, with `POSTGRES_APP_PASSWORD`)                                 | `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`; a member of no other role; owns nothing; `USAGE` on the schemas, `SELECT, INSERT, UPDATE, DELETE` on every table, `USAGE` on every sequence; never `CREATE`                                             |
| **maintenance** | `worker` (and `migrate`, which creates it)                                      | `DATABASE_MAINTENANCE_URL` (Compose: `POSTGRES_MAINTENANCE_USER`, default `app_maintenance`, with `POSTGRES_MAINTENANCE_PASSWORD`) | the app role's grants, and `BYPASSRLS`: the worker's sweeps across tenants and the metrics over every tenant ([tenancy](tenancy.md), "The bypass"); never on api                                                                                           |
| **monitor**     | a PostgreSQL exporter you run, outside the stack                                | `POSTGRES_MONITOR_USER` (default `app_monitor`) with `POSTGRES_MONITOR_PASSWORD`; managed PostgreSQL: `DATABASE_MONITOR_URL`       | the same flags as the app role (`NOBYPASSRLS`: no tenant's rows, nor any table's); a member of `pg_monitor` and of nothing else (`pg_stat_*`, the settings, sizes); owns nothing; no privilege on any table: statistics, never rows                        |
| **reporting**   | platform analytics: a BI tool, outside the stack                                | `POSTGRES_REPORTING_USER` (default `app_reporting`) with `POSTGRES_REPORTING_PASSWORD`                                             | the same flags as the app role; a member of nothing; owns nothing; `SELECT` on the `analytics` schema's tables (anonymized, suppressed aggregates) and no privilege on any other table: never a tenant's row ([tenancy](tenancy.md), "Platform analytics") |

- **Extensions:** migrations create `pg_trgm` (trigram indexes for the lists'
  `ILIKE` filters). It is a trusted extension, so the owner
  (`DATABASE_OWNER_URL`) needs only `CREATE` on the database, which an owner
  has. A managed PostgreSQL must offer `pg_trgm`; the common ones do (RDS,
  Cloud SQL, Azure, Supabase, Neon).
- **Leakproof filters:** under row-level security PostgreSQL uses an index
  for a condition only when its function is `LEAKPROOF`, and `ILIKE`
  (`texticlike`) and full-text `@@` (`ts_match_vq`) are not by default: a
  `?title.contains=` or `?q=` then reads the whole table. Each migrate marks
  them when the owner is a superuser (Compose); any other owner (managed
  PostgreSQL) logs the two `ALTER FUNCTION … LEAKPROOF` statements for one
  to run, or for the provider's support. The filters work either way, only
  slower without (#851).

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
- **The monitoring role** (`ensureMonitorRole()`, the same file) exists
  only when `POSTGRES_MONITOR_PASSWORD` (or its `_FILE`) is set:
  `migrate` creates `POSTGRES_MONITOR_USER` with it, grants it
  `pg_monitor`, and verifies before committing that it is a member of
  nothing else (`pg_read_all_data`, the owner or the app role would hand it
  the rows), owns nothing, creates nothing and holds no privilege on any
  application table; a password that fails is set, as for the app role.
  Without the password, `migrate` says so and skips it. `GRANT pg_monitor` needs the owner to
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
- **Upgrading to tenancy (1a)** is a reset, not a migration of data for a
  disposable demo deployment. Add `POSTGRES_MAINTENANCE_PASSWORD=$(openssl rand -hex 24)`
  to `.env` first: the tenancy migration adds `tenant_id NOT NULL`
  with no default, which fails on tables that hold rows. Back up, then start
  from an empty database (`docker compose down`, remove the `postgres_data`
  volume, `docker compose up -d --build --remove-orphans`); the first start
  makes the operator tenant (`ADMIN_TENANT_NAME`) and the administrator.
- **Upgrading a deployment made before the roles:** add
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
- **Rolling back past this release** is not an image change alone:
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
PgBouncer (transaction mode) in front of PostgreSQL, or a larger
`max_connections` (each connection costs PostgreSQL memory). Workers need a
pool at least as large as what they run at once (workflow steps, job
concurrency).

### Automatic database incidents

Every API and worker process measures database connection acquisition separately from command
execution. Acquisition includes establishing a connection; command duration includes network and
lock waits. `database_busy` and SQLSTATE `57014` cancellations produce structured
`event=database_incident` warning logs. A statement still running after one second also produces an
incident; pool waiting across two five-second checks produces `pool_waiting`. Cancellation reasons
are restricted to fixed values (`statement_timeout`, `user_cancellation`, `query_cancellation`),
without the driver's SQL text, detail, or parameter values.

Incident evidence is in the JSON log entry's `params` object (for example `params.incidentId`).
Each incident includes an `incidentId`, replica, request/trace IDs when present, matched route
pattern, operation, SHA-256 query-template fingerprint, duration, backend PID when available, and
application pool state. Log lines are limited to five per fingerprint and trigger per 60 seconds, then one
`database_incident_summary` entry carries the suppressed count; metrics still count every incident. A
`slow_query` is recorded only when its duration minus the recent event-loop lag (p99, 10-second window)
is still at least one second, so a saturated process does not report its own lag as slow queries. A fingerprint identifies the submitted SQL template; it is not a database
execution plan or a guarantee that two queries differing in literal SQL have the same fingerprint.
No request IDs, fingerprints, or SQL values become metric labels. HTTP problem responses are unchanged.

Set optional `DATABASE_MONITOR_URL` **or** `DATABASE_MONITOR_URL_FILE` to the existing statistics-only
`pg_monitor` credential to enable snapshots. The monitor role is provisioned as described in
"Database roles"; never use the owner, application, or maintenance URL. Runtime checks reject a
superuser, BYPASSRLS role, or a role without pg_monitor membership. The collector only reads role
metadata and `pg_stat_activity`, never application tables or query text. It does not run EXPLAIN,
replay statements, create indexes, cancel application queries, change pool limits, or restart services.

The diagnostics pool has one connection per process, independently of application connections.
Include these extra connections in the deployment's PostgreSQL connection
budget. Each snapshot has a one-second **overall** deadline and at most 20 sessions, with query and
transaction ages, query IDs when PostgreSQL supplies them, wait events, and blocking PIDs. Capture
starts asynchronously while slow statements are still running. A busy collector or the 30-second
per-process cooldown suppresses only the snapshot; every incident is recorded with `captureStatus`.
Missing credentials produce `unconfigured`; connection, role, or deadline failures produce a correlated
`database_snapshot` log with `captureStatus=unavailable`. Diagnostic failures never change the original
request's result. Observed blockers/waits are evidence, not an automatically confirmed root cause.

Compose mounts `DATABASE_MONITOR_URL_FILE` for API/worker when configured.
Snapshots remain available when the application pool is exhausted.

`/metrics` exposes `db_connection_acquire_duration_seconds`, `db_query_duration_seconds`,
`db_failures_total{code}`, `db_last_failure_timestamp_seconds{code}`, `db_incidents_total{trigger}`, and
`db_pool_max_connections` alongside the existing pool gauge, for the dashboards and alerts of a
Prometheus you run. Enabling this feature sends no email, Slack message or webhook notification.

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

Optional: [attachments](attachments.md) can be scanned for malware by a clamd
you run (the stack ships none). Set `MALWARE_SCANNER=clamav` and
`CLAMAV_HOST` (and `CLAMAV_PORT`, default 3310) for `api` and `worker`.

- **Size:** clamd refuses a stream over its `StreamMaxLength`: set it (and
  `MaxFileSize`) to at least `ATTACHMENT_MAX_MB`. Until clamd answers, scans
  fail and are tried again, and uploads stay `pending`.
- **Off** (`MALWARE_SCANNER=off`, the default): no scan and no `pending`
  state. Turning it on later leaves existing attachments `clean` (unscanned);
  turning it back off releases the uploads still `pending` as `clean` within
  minutes (nothing will scan them), audited as `attachments.released`.
- **Metric:** `attachments_scanned_total{result}` ([below](#metrics)).

## Metrics

`GET /metrics` serves Prometheus metrics (prom-client, `apps/api/src/core/metrics/`)
on every process, api and worker alike (port 3000): HTTP request durations
(`http_request_duration_seconds{method,route,status}`, `route` the matched
pattern such as `GET /v1/notes/{id}`, unmatched requests `unmatched`; the
scrape and `/health` are not measured), `http_requests_in_flight`, the
process's pool (`db_pool_connections{state="total|idle|waiting"}`), jobs
per queue and state (`queue_jobs{queue,state}`; worker-capable processes only) and how long
each queue's oldest waiting job has waited (`queue_oldest_waiting_seconds{queue}`), the outbox
(`outbox_undelivered`, `outbox_undelivered_by_topic{topic}` (the 50 largest topics),
`outbox_dead_letters`, `outbox_lag_seconds`), the
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
Queue, outbox and webhook gauges are shared state: worker-capable processes
(`APP_ROLE=worker` or `all`) report them, so aggregate them with `max()`, not
`sum()`. Outbox pending, dead-letter and due-lag values share one read-only
aggregate query per process, cached for 30 seconds; the due lag continues to
age between reads. The query has a 1500 ms PostgreSQL statement timeout. A
gauge whose read fails (PostgreSQL or Redis away) is left out of that scrape,
not set to 0 or reused from an earlier snapshot.

- **Off by default:** without `METRICS_TOKEN`, `/metrics` answers 404. Set it
  (`openssl rand -hex 24`, at least 16 characters); Prometheus then sends
  `Authorization: Bearer <token>` (`authorization: { credentials: ... }` in
  its scrape config), anything else gets 401.
- **Inside the Compose network only:** run your Prometheus on the stack's
  network and scrape every replica through Docker's DNS:

  ```yaml
  scrape_configs:
    - job_name: api
      authorization: { credentials_file: /etc/prometheus/metrics-token }
      dns_sd_configs: [{ names: [api, worker], type: A, port: 3000 }]
  ```

- **Not rate limited**, like `/health`: the limiter counts in Redis, and the
  scrape must keep working while Redis is away (its gauges then go absent).
- **Never through Caddy:** `caddy/Caddyfile` answers `/metrics` with 404
  before the proxy (`respond /metrics* 404`), so the token is never the only
  thing between the internet and the metrics. Keep that line when editing
  the Caddyfile.

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
of three, none required: Observe, your own collector over OpenTelemetry, and
Sentry for errors. Which combinations are supported is in
[Telemetry](#telemetry).

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

Three switches, each off until its variable is set, so a project is not tied to
one hosted vendor. prom-client's `/metrics` ([Metrics](#metrics)) is separate
and unaffected by any of them. Supported combinations:

| Set | What runs |
| --- | --- |
| nothing | no telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the standalone OpenTelemetry SDK: traces and metrics to your collector |
| `OBSERVE_APP_KEY` + `OBSERVE_APP_SECRET` | NestJS Observe alone |
| both of the above | **Observe only**, joined to your collector: its `openTelemetry` and `otlp` options export Observe's spans (providers included) to `OTEL_EXPORTER_OTLP_ENDPOINT`, and the standalone SDK is not started. Observe and the SDK would instrument http and pg twice, and Observe's OTLP export would send every trace a second time. OTLP metrics are not exported in this mode (Observe has its own, and `/metrics` stays) |
| `SENTRY_DSN` beside any row | adds error tracking; always supported |

In the Observe-and-collector row the collector sees spans only, from Observe's
exporter, and `traceId` in the log lines is Observe's. A refused OTLP export
(401, 403, 429) is still counted in `telemetry_rejected_total{target="otlp"}`,
read from Observe's log line. Sentry's own tracing (`SENTRY_TRACES_SAMPLE_RATE`)
runs its own OpenTelemetry setup: leave it unset when Observe or the SDK
traces.

- **`OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET`:** NestJS Observe (above),
  hosted traces, metrics and errors.
- **`OTEL_EXPORTER_OTLP_ENDPOINT`** (and `OTEL_EXPORTER_OTLP_HEADERS` for the
  collector's credential, e.g. `x-honeycomb-team=KEY`): OpenTelemetry through
  `@opentelemetry/sdk-node` (without Observe). Traces and metrics go over
  OTLP/HTTP to any collector (Grafana Tempo, Jaeger, Honeycomb, Datadog):
  spans for HTTP and undici (named after the matched route), PostgreSQL,
  Redis and socket.io events, and runtime metrics. Only those instrumentation
  packages are installed (`telemetry.ts`), not the
  `auto-instrumentations-node` bundle. The SDK reads the standard `OTEL_*` variables too
  (`OTEL_SERVICE_NAME`, defaulting to `SERVICE_NAME`; `OTEL_TRACES_SAMPLER`,
  …).
- **`SENTRY_DSN`** (and `SENTRY_TRACES_SAMPLE_RATE`, 0 to 1): Sentry
  (`@sentry/nestjs`) gets the 5xx the problem-details filter answers, with
  the request id and error code as tags. Errors only unless the sample rate
  is set.

`main.ts` awaits `core/observability/instrument.ts` (after the development
settings) before it loads anything else: the SDKs patch `http` and
the database and Redis clients as they load, so they start first. The app's
modules are imported with `await import()` after it, not as static imports
below it: a module's top-level `await` holds back only the modules that
import it, so static imports would load Nest and `pg` while the SDKs
were still starting, and nothing would be traced. The packages are imported
only when their variable is set. Libraries loaded through `require` or a CJS
`import` (`pg`, `ioredis`) are instrumented. NestJS's own
instrumentation (`@opentelemetry/instrumentation-nestjs-core`) does not
support Nest 12 yet, so there are no spans of controllers and providers;
Nest's native HTTP adapter has no instrumentation either, so
`core/http/route-key.ts` names each server span after the matched route
(`GET /v1/notes/:id`, `http.route`).

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
  rate-limited (429)", because it has no hook), and alert on it
  in your Prometheus. The OTLP exporters
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
  so they need no such exclusion. To prove it locally, run e2e specs with
  `OTEL_EXPORTER_OTLP_ENDPOINT` and `SENTRY_DSN` pointing at a stub collector
  (`node apps/api/test/telemetry-stub.mjs serve`, then `check`): it fails if
  no span of a request the app served reached it (CI no longer runs this:
  it repeated the e2e jobs' tests). `apps/api/test/setup-env.ts` starts the SDKs when
  either variable is set, before it loads the app: the order that works, so
  the suite alone cannot show a wrong one in `main.ts`. The last step of
  `e2e-web` starts the built API (`node dist/main`) against a collector of its
  own (`node apps/api/test/telemetry-stub.mjs boot`, with `DATABASE_URL`,
  `DATABASE_OWNER_URL`, `DATABASE_MAINTENANCE_URL` and `REDIS_URL` set, as for
  the browser tests): the credentials are `_FILE` secrets, and it fails unless
  the request it sent was traced (HTTP spans named after their route, and
  `pg` spans) with the
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
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant:list` | the tenants: id, slug, members, active |
| `user:list <tenant>` | a tenant's users (id or slug): roles, two-factor, active |
| `admin:create <email> [--tenant <id\|slug>] [--name <name>]` | an administrator of a tenant (`--tenant` is optional when the deployment has one tenant). A new address gets an account (verified) and a one-time password; an existing account keeps its password and becomes the tenant's administrator |
| `user:reset-password <email>` | a new one-time password; every session and token client of the account is signed out, and their realtime connections on the API end (through Redis) |
| `user:remove-mfa <email>` | removes the authenticator and the recovery codes, clears the failed-code counter, revokes the account's tokens |
| `user:unlock <email>` | clears the failed second-factor attempts (the 15-minute lockout) and takes the address off the mail suppression list. Per-address rate limits (Redis) lapse by themselves within minutes |
| `notifications:settle <email> [--before <date>]` | drops a user's undelivered `notifications.deliver` outbox messages (all, or created before the date) and marks their notifications delivered and read; `mandatory` types are left alone. Shows the counts first; works tenant by tenant in chunks of 5,000, so a backlog of hundreds of thousands never meets the statement timeout (docs/notifications.md, "Stopping a mail storm") |
| `backlog:count (--tenant <id\|slug> \| --global) [--topic <t>] [--type <t>] [--template <mail>] [--before <date>]` | the dry run: the outbox backlog (pending by topic and notification type, dead letters, being delivered) and the `mail` queue (jobs by state and mail class) of one tenant, or of every tenant with `--global` (exactly one). Changes nothing |
| `backlog:discard <outbox\|mail> (--tenant … \| --global) [filters]` | deletes that backlog in batches of 1,000: pending outbox messages not being delivered and dead letters (a discarded notification stays listed, marked delivered, with no push, mail or webhook), or the mail queue's waiting, delayed and failed jobs. Never a `mandatory` notification type, essential mail or running work. Audited as `ops.backlog-discarded` (docs/notifications.md, "Stopping a mail storm") |
| `backlog:retry <outbox\|mail> (--tenant … \| --global) [filters]` | requeues the dead letters in scope, or retries the failed mail jobs; the mail mode and budgets still apply. Audited as `ops.backlog-retried` |
| `queue:pause <name>`, `queue:resume <name>` | pauses or resumes one queue for every worker (BullMQ, kept in Redis; nothing is lost). Leaving maintenance mode resumes every queue. Audited as `queue.paused` / `queue.resumed` |
| `setting:delete <key> (--tenant <id\|slug> \| --platform)` | removes a stored value; the next scope's, or the default, holds again |
| `diagnostics [--test]` | the integrations' states (see [Diagnostics](#diagnostics)); `--test` runs their safe tests too, each audited as `ops.diagnostic-tested`. Exits 1 when one is unconfigured, unavailable or fails its test. Asks nothing: it changes nothing |

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
`compose.prod.yaml`'s service. Elsewhere, run the image on the app's
network: `docker run --rm -it --network <network> --env-file .env
$APP_IMAGE node dist/cli …`. The command needs
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

## Diagnostics

One view of the integrations a deployment needs, for setting it up and
for an outage: `GET /v1/ops/diagnostics` (the operations page's
"Diagnostics" tab, and `pnpm ops diagnostics` on a server). Operators only
(`@OperatorOnly()`, docs/tenancy.md) with `Ops.view`.

| Check | `ok` / `configured` | `disabled` | `unconfigured` | `unavailable` |
| ---------- | --------------------------------- | -------------- | --------------------------------------- | --------------------------------------- |
| `database` | answered a ping | | | no answer within 5 s |
| `redis` | answered PING | | | no answer |
| `workers` | a worker is connected to a queue | | | none (start `APP_ROLE=worker` or `all`) |
| `mail` | `MAIL_TRANSPORT` set (configured) | | `file`, `log` or `memory` in production | its test failed |
| `storage` | `STORAGE_DRIVER` set (configured) | | `memory` in production | its test failed |
| `realtime` | Redis answers | `REALTIME=off` | | Redis does not answer |

Each item carries the driver's name (`smtp`, `s3`), a masked error and a
hint at the fix. It is built from switches and driver names: no URL,
host credential, key or token is ever read back, and an error's text goes
through the log-redaction registry and is cut, as in the logs.

**Safe tests** (`POST /v1/ops/diagnostics/{check}/test`, `Ops.manage`):
nothing a user sees and nothing kept. SMTP connects, authenticates and
says QUIT (no mail; the HTTP providers have no such call, so `mail` is
testable with `smtp` only); storage writes, reads back and deletes a
probe file under `ops/diagnostics/`; the others ping. A failure answers
200 with `ok: false`, the masked reason and the hint. Ten per minute per
user (429 `rate_limited` past it), each audited as `ops.diagnostic-tested`
(`details.ok`, `durationMs`).

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

## CI

The **CI** workflow (`.github/workflows/ci.yml`) validates changes. It builds
and scans the two images, and neither publishes nor deploys them: pushing
images to a registry and deploying are the adopting project's own workflows.

Application validation stays centralized here. Workflows with different path
triggers, permissions or schedules (migrations, docs) remain separate. PR
concurrency groups include the workflow and PR ref, cancelling superseded runs
without cancelling other PRs.

### Which jobs a pull request runs

`tools/ci/changes.mjs` classifies PR files and ordinary `main` push comparisons.
Renames count at both paths, and deleted files count too. A missing or empty
comparison, a capped list (300 compare files or 3000 PR files), inconsistent PR
file counts, unknown paths and shared root dependencies trigger comprehensive
validation. A failed compare never silently skips tests. A release commit
(`CHANGELOG.md`, `.release-please-manifest.json` and only the version in the
root `package.json`) runs no tests ([releases](releases.md)). Sunday's scheduled run (03:17 UTC), manual full
runs and `v*` tags are comprehensive; weekday nights scan only the images and
the dependencies for new advisories.

| Change | Validation |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API | lint/build, API unit coverage, API E2E, browser/accessibility tests, migrations, security, API image |
| Web/UI | lint/build, web/package coverage, browser/accessibility tests, security and Caddy image checks |
| Typed client/shared roots | dependent packages; shared root dependencies run comprehensive validation |
| Tooling (`tools/`) | lint, Knip and the tools' own tests; the generator smoke runs on comprehensive runs only |
| Compose service images | database/browser E2E on those images |
| Stack/images | stack config (secrets, hardening) and image checks |
| CI orchestration | routing, gate and workflow syntax tests |
| Docs                         | the corresponding companion workflow                                                                                                                    |

The classifier has explicit routes for infrastructure, generators, migrations and
image contexts. Workspace lint/build/coverage tasks use Turbo's `--affected` with
explicit `TURBO_SCM_BASE`/`TURBO_SCM_HEAD` and full checkout history. When a
comparison includes inputs outside the workspace graph, explicit routing retains
the necessary tasks. Knip and translation parity still inspect the whole workspace.

| Job | Purpose |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes` | classification and expected jobs |
| `check` | affected lint/build, API and package unit coverage, API client/migrations when relevant, bundle budget, the tools' tests, leftover-notes guard |
| `unit-web` | web unit coverage, whole, thresholds enforced directly |
| `e2e`, `e2e-web` | isolated API/database and browser/accessibility tests; `e2e-web` also runs the built app's trace check |
| `feature-smoke` | generated features, schema/client generation and their E2E tests; comprehensive runs only |
| `tooling-lint` | lint, Knip and the tools' tests for a change to tooling alone |
| `template-without-notes` | exhaustive generated-template variant; manual runs only |
| `stack-config` | shellcheck over the tracked shell scripts; Compose secrets, hardening and settings |
| `security`, `image`, `caddy-image` | dependency/secret/configuration scans and the image builds, scans and checks |
| `ci-gate` (**CI gate**) | requires every classified job to succeed; rejects missing results, failures, cancellations and unexpected skips; for API changes then merges the unit and e2e coverage blobs and enforces the merged thresholds |

Require **CI gate** as the stable application status check, rather than individual
matrix names that may not exist on an unaffected PR. Companion workflows retain
their checks. Any new validation job must be added to the classifier's expected
jobs and gate dependencies; tests compare real workflow conditions with that list.

Turbo caches are namespaced by job and matrix entry, with matching restore
prefixes. `test:cov` stores both `.vitest/**` (raw coverage) and
`coverage/**`. CI mode, Node mode,
root configuration, public build variables and the build SHA participate in
relevant hashes. Database and browser E2E remain uncached. Cache keys do not
replace task-input hashing. See [CI measurements](ci-runtime.md) for the
runner budget, the evidence and the chosen defaults.

The bundle budget and the Storybook build run in `check` for frontend changes,
and the browser tests in `e2e-web`. The Web workflow holds only report-only
Lighthouse, which runs manually.
Migration lint retains its separate PR workflow and existing acceptance controls
([migrations](development.md#migrations)). Third-party actions remain pinned;
Dependabot proposes updates. PostgreSQL and Redis are read from `compose.yaml`,
so tests use the same versions as the development stack.

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
