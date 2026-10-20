# Configuration

Every variable is validated at startup (`apps/api/src/env.ts` merges each group's
`*.env.ts`): a missing or malformed one stops the app with its name, never its
value. Every secret can come from a file instead ([Secrets](#secrets)). Read
them with `ConfigService<GroupEnv, true>` (`config.get('PORT', { infer: true })`).

- First run: `pnpm setup` asks a few questions and writes either file below
  with the secrets generated ([First setup](#first-setup-pnpm-setup)).
- Production: `.env` is Docker Compose's file (`pnpm setup --target production`,
  or by hand `cp env.example .env`, then
  fill it: `env.example` marks what is required); the containers get their variables from `compose.prod.yaml`.
- Development: `apps/api/.env.development` (`cp
  apps/api/env.development.example apps/api/.env.development`), optional.
  The app finds it next to its package.json whatever directory it starts
  from (`apps/api/src/dev-env.ts`).
- Tests: `apps/api/test/setup-env.ts`.
- Relative paths (`STORAGE_ROOT`, `MAIL_DIRECTORY`) resolve against the
  app's directory: `apps/api` in development, `/app` in the image (the
  `app_storage` volume is mounted on `/app/.data/storage`).
- Secrets left unset are created once and kept in the database
  (`loadOrCreateSecret`): `JWT_SECRET`, `MFA_ENCRYPTION_KEYS`,
  `STORAGE_SIGNING_KEYS`, `IDEMPOTENCY_KEYS`, `CURSOR_KEYS`, the incoming
  webhook secrets.
  Set them in `.env` to keep them out of the database (`openssl rand -base64
  32` each); keys are comma-separated, newest first (add a new one in front
  to rotate).
- `WEBHOOKS_ENCRYPTION_KEYS` is not created: unset, webhook endpoint secrets
  are stored unencrypted. Set it in production (`openssl rand -base64 32`).
- Required in production: `APP_DOMAIN`, `ACME_EMAIL` (Compose stops
  without them), `CLOUDFLARE_API_TOKEN`, `POSTGRES_PASSWORD` and
  `POSTGRES_APP_PASSWORD` (`openssl rand -hex 24` each: they go into URLs,
  so no `/`, `+` or `=`), or each one's `_FILE` ([deployment.md](deployment.md),
  "Secrets in files"). `REDIS_PASSWORD` is optional but recommended.
- Two database roles ([deployment.md](deployment.md), "Database roles"):
  `DATABASE_URL` is the app's (api, worker: owns nothing, no DDL, no RLS
  bypass), `DATABASE_OWNER_URL` the owner's (`migrate`; the app itself only
  when `MIGRATE_ON_START` is on, which then requires it).

| Group | Variables |
| --- | --- |
| Runtime | `NODE_ENV` (`development` set explicitly is half of the demo seed's check: [development](development.md), "Demo data"), `APP_ENV` (the deployment's name; `loadtest` only for the load test's stack), `APP_ROLE` (`all`/`api`/`worker`), `PORT`, `SERVICE_NAME`, `OPENAPI`, `CURSOR_KEYS` (seals sorted lists' `nextCursor`; unset: created once, kept in the database) |
| URLs | `APP_URL` (this API), `WEB_URL` (the web app, for email links), `CORS_ORIGINS` |
| Database | `DATABASE_URL` (required, PostgreSQL 18+, the app role), `DATABASE_OWNER_URL` (the owner: `migrate`, and the app when `MIGRATE_ON_START` is on), `DATABASE_MAINTENANCE_URL` (the maintenance role, BYPASSRLS: workers' sweeps across tenants, never api; docs/tenancy.md), `MIGRATE_ON_START`, `DATABASE_POOL_MAX` (10), `DATABASE_POOL_TIMEOUT_MS` (5000), `DATABASE_STATEMENT_TIMEOUT_MS` (30000), `DATABASE_IDLE_TX_TIMEOUT_MS` (60000); Compose: `POSTGRES_USER` (`app`, the owner), `POSTGRES_PASSWORD`, `POSTGRES_APP_USER` (`app_runtime`), `POSTGRES_APP_PASSWORD`, `POSTGRES_MAINTENANCE_USER` (`app_maintenance`), `POSTGRES_MAINTENANCE_PASSWORD`, `POSTGRES_DB` (`app`), `POSTGRES_MONITOR_USER` (`app_monitor`: the PostgreSQL exporter's role, `pg_monitor` only, NOBYPASSRLS) and `POSTGRES_MONITOR_PASSWORD` (required with `compose.monitoring.yaml`; or `DATABASE_MONITOR_URL` on a managed PostgreSQL), `POSTGRES_REPORTING_USER` (`app_reporting`: platform analytics' role, reads the `analytics` aggregates only; [tenancy.md](tenancy.md), "Platform analytics") and `POSTGRES_REPORTING_PASSWORD` (empty: no such role), `API_DATABASE_POOL_MAX` (10), `WORKER_DATABASE_POOL_MAX` (20), `POSTGRES_MAX_CONNECTIONS` (100) |
| Redis | `REDIS_URL` (Redis 7.0 or newer: `EXPIRE NX`; checked at start, [deployment.md](deployment.md), "Redis"), `REDIS_PASSWORD` (replaces the URL's: for one in a file), `REDIS_SENTINELS`, `REDIS_SENTINEL_NAME`, `REDIS_PREFIX`, `RATE_LIMIT_STORE`, `RATE_LIMIT_MULTIPLIER` (1: every rate limit times this; the load test's stack only, [development](development.md), "Load tests": with `NODE_ENV=production`, above 1 stops the app unless `APP_ENV=loadtest`) |
| Logs and traces | `LOG_FORMAT`, `LOG_LEVEL`, `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` |
| Metrics | `METRICS_TOKEN` (Prometheus' bearer token for `GET /metrics`, at least 16 characters; unset: 404; [deployment.md](deployment.md), "Metrics") |
| Alerting (`compose.monitoring.yaml`, optional) | `ALERT_EMAIL_TO`, `ALERT_SMTP_URL` (default: `SMTP_URL`), `ALERT_SMTP_REQUIRE_TLS` (true), `ALERT_EMAIL_FROM` (default: `MAIL_FROM`), `ALERT_WEBHOOK_URL`, `ALERT_SLACK_WEBHOOK_URL`; `PROMETHEUS_PORT` (9090), `ALERTMANAGER_PORT` (9093), both on 127.0.0.1; `PROMETHEUS_CPUS` (0.5), `PROMETHEUS_MEMORY` (1G), `ALERTMANAGER_CPUS` (0.25), `ALERTMANAGER_MEMORY` (128M); [deployment.md](deployment.md), "Alerting" |
| Languages and time | `LOCALES`, `APP_TIMEZONE` |
| Mail | `MAIL_TRANSPORT`, `MAIL_FROM`, `SMTP_URL`, `MAIL_API_KEY`, `MAIL_DIRECTORY` (`.data/mail`), `SES_ENDPOINT` (Floci) |
| Deliverability | `SES_SNS_TOPIC_ARNS` (the SNS topics SES publishes bounces and complaints to; empty: `POST /v1/webhooks/mail/ses` refuses everything), `MAIL_SOFT_BOUNCE_THRESHOLD` (3: transient bounces before an address is suppressed), `MAIL_SOFT_BOUNCE_WINDOW_HOURS` (24: they count when the last is at most this old), `MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS` (72: how long a soft-bounce suppression lasts), `SES_SNS_REQUIRE_SIGNATURE_V2` (`off`: refuse SignatureVersion 1), `MAIL_EVENTS_RETENTION_DAYS` (90: the bounce, complaint and delivery events); [deliverability.md](deliverability.md) |
| Deployment switches | `WEBHOOKS`, `REPORTS`, `USAGE`, `REALTIME` (all `on`; [below](#deployment-switches)) |
| Webhooks | `WEBHOOKS_DELIVERY_RETENTION_DAYS` (30: finished outgoing deliveries, with their attempt log and recorded request; [webhooks](webhooks-and-realtime.md#retention)) |
| Background | `SCHEDULER`, `OUTBOX_RELAY`, `WEBHOOKS_WORKER`, `BULK_SYNC_LIMIT` (100: bulk runs of up to this many ids answer in the request, larger ones are queued) |
| Notifications | `NOTIFICATIONS_DIGEST_HOUR` (8: daily digests, in each user's time zone), `NOTIFICATIONS_RETENTION_DAYS` (90: read ones), `NOTIFICATIONS_MAX_AGE_DAYS` (365: any) |
| Attachments | `ATTACHMENT_MAX_MB` (25), `ATTACHMENT_ALLOWED_TYPES` (comma-separated MIME types, detected from the bytes; default: JPEG, PNG, GIF, WebP, PDF, docx, xlsx, pptx, plain text, CSV, zip) |
| Documents | `GOTENBERG_URL` (unset: PDF documents are off, 503 `documents_unavailable`; Compose: `http://gotenberg:3000`), `GOTENBERG_TIMEOUT_MS` (30000: one render's limit), `DOCUMENTS_RENDER_ATTEMPTS` (3: tries per document) ([documents](documents.md)) |
| Password hashing | `PASSWORD_HASH_CONCURRENCY` (2; Compose: `API_PASSWORD_HASH_CONCURRENCY` 2, `WORKER_PASSWORD_HASH_CONCURRENCY` 1), `PASSWORD_HASH_MAX_QUEUE` (20), `PASSWORD_HASH_QUEUE_TIMEOUT_MS` (5000): past them, 503 `server_busy`; the memory limit holds the heap plus 128 MiB per hash, [deployment.md](deployment.md#resource-limits) |
| Breached passwords | `PASSWORD_BREACH_CHECK` (`on`), `PASSWORD_BREACH_API_URL` (`https://api.pwnedpasswords.com`, or a mirror), `PASSWORD_BREACH_TIMEOUT_MS` (2000), `PASSWORD_BREACH_ON_ERROR` (`allow`: fail-open; `reject`: 503), `PASSWORD_BREACH_MIN_COUNT` (1), `PASSWORD_BREACH_RECHECK_DAYS` (30: a sign-in's password is checked again after this long); [auth.md](auth.md#passwords) |
| Accounts (self-service) | `ACCOUNT_DELETION_GRACE_DAYS` (14: until a requested deletion is carried out) |
| API usage | `USAGE_RETENTION_DAYS` (400: API clients' daily usage, [usage.md](usage.md)) |
| Platform analytics | `ANALYTICS_MIN_GROUP_SIZE` (10, at least 2: a count below it is withheld from the reporting role's aggregates; [tenancy.md](tenancy.md), "Platform analytics") |
| Revisions | `REVISIONS_RETENTION_DAYS` (365: record revisions; each record's latest stays, [revisions.md](revisions.md)) |
| Money | `EXCHANGE_RATES_FETCH` (`on`: the ECB's reference rates every working day), `EXCHANGE_RATES_ECB_URL` (`https://www.ecb.europa.eu/stats/eurofxref`, or a mirror); [money.md](money.md) |
| Scheduled reports | `REPORT_LINK_TTL` (`24h`: how long a report mail's download link works, at most `7d`; [reports.md](reports.md)) |
| Accounts | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_TENANT_NAME` (the first tenant, the operators': docs/tenancy.md), `TENANCY` (`multi`; `single`: the first tenant is the only one), `SIGN_UP_ROLES` (`single`: the roles a sign-up gets, seed role keys; none by default), `INVITATION_TTL_HOURS` (168: how long an invitation to a tenant works), `TENANT_DELETION_GRACE_DAYS` (30: until an operator's tenant deletion is carried out), `SESSION_COOKIE_SECURE`, `AUTH_SIGN_UP`, `TENANT_SIGN_UP` (off; on, with `multi` and `AUTH_SIGN_UP`: a sign-up makes its own tenant and administers it, docs/tenancy.md, "Tenants made at sign-up"), `AUTH_MAGIC_LINK`, `JWT_SECRET`, `MFA_ENCRYPTION_KEYS`, `MFA_ISSUER`, `IMPERSONATION` (off: a privileged support tool, opt in), `IMPERSONATION_TTL_MINUTES`, `AUTH_MFA` (on; off: no new enrollments, enrolled users still asked), `API_CLIENTS` (on; off: no client routes, no keys accepted), `REAUTHENTICATION_MAX_AGE_MINUTES` (10: how long a sign-in counts for the sensitive routes), `AUDIT_RETENTION_DAYS`, `SOFT_DELETE_RETENTION_DAYS` (30: the recycle bins) |
| Passkeys | `PASSKEYS` (`on`), `PASSKEY_RP_ID` (the relying party: default `WEB_URL`'s host, else `APP_URL`'s; never change it once passkeys exist), `PASSKEY_RP_NAME` (default `SERVICE_NAME`), `PASSKEY_ORIGINS` (more origins under the RP ID), `PASSKEY_CHALLENGE_TTL_SECONDS` (120), `PASSKEY_ANDROID_APPS` (`package:SHA256-fingerprint`), `PASSKEY_APPLE_APPS` (`TEAMID.bundle.id`). Refused at boot: an origin outside the RP ID; in production also `localhost`, an IP address or plain http (or `PASSKEYS=off`); [auth.md](auth.md#passkeys) |
| Bot protection | `CAPTCHA_MODE` (`off`; `always`, `after-failures`), `CAPTCHA_PROVIDER` (`turnstile`; `stub` for tests and load tests, refused in production), `TURNSTILE_SITE_KEY` (public), `TURNSTILE_SECRET_KEY`, `CAPTCHA_VERIFY_URL` (Cloudflare's siteverify), `CAPTCHA_HOSTNAMES` (the widget's hosts; default: `WEB_URL`'s), `CAPTCHA_TIMEOUT_MS` (2000), `CAPTCHA_ON_ERROR` (`allow`: fail-open under `CAPTCHA_DEGRADED_LIMIT` (2) per address in the window; `reject`: 503), `CAPTCHA_FAILURES` (3), `CAPTCHA_FAILURES_WINDOW_MINUTES` (15); [auth.md](auth.md#bot-protection) |
| Sign in with | `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_TENANT_ID/CLIENT_ID/CLIENT_SECRET`, `GITHUB_CLIENT_ID/SECRET` (redirect URI: `<APP_URL>/v1/auth/oidc/<provider>/callback`) |
| Files | `STORAGE_DRIVER` (`local`/`s3`), `STORAGE_ROOT` (`.data/storage`), `STORAGE_SIGNING_KEYS`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` |
| AWS (S3, SES) | `AWS_REGION` (also S3's default region), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; unset keys: the packages read `process.env` |
| Platform keys | `IDEMPOTENCY` (`required`; `optional`: [api-conventions.md](api-conventions.md#idempotency)), `IDEMPOTENCY_KEYS`, `WEBHOOKS_ENCRYPTION_KEYS`, `WEBHOOKS_ALLOW_LOOPBACK` (development only: lets endpoints be `http://127.0.0.1` or `localhost`; [webhooks-and-realtime.md](webhooks-and-realtime.md), "A receiver on your machine") |
| Compose | `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `APP_IMAGE`, `GOTENBERG_IMAGE`, `CADDY_IMAGE` (unset: built from the checkout; a published image: [deployment.md](deployment.md), "Publishing and rolling back images"), `API_REPLICAS`, `WORKER_REPLICAS`, `API_CPUS`, `API_MEMORY` (768M), `API_HEAP_MB` (384), `API_PASSWORD_HASH_CONCURRENCY` (2), `WORKER_CPUS`, `WORKER_MEMORY` (1G), `WORKER_HEAP_MB` (768), `WORKER_PASSWORD_HASH_CONCURRENCY` (1), `POSTGRES_CPUS`, `POSTGRES_MEMORY`, `REDIS_PASSWORD`, `REDIS_CPUS`, `REDIS_MEMORY`, `REDIS_MAXMEMORY` (the PostgreSQL roles: the Database row) |
| Caddy | `APP_DOMAIN`, `CLOUDFLARE_API_TOKEN`, `ACME_EMAIL` |
| Backups (Compose, [deployment.md](deployment.md), "Backups and restore") | `BACKUP_SCHEDULE` (`0 3 * * *`, cron, UTC), `BACKUP_RETENTION_DAYS` (14: in the `backups` volume), `BACKUP_MAX_AGE_HOURS` (25: older, a catch-up runs and the service turns unhealthy), `BACKUP_CPUS` (0.5), `BACKUP_MEMORY` (512M); off the host, all optional: `BACKUP_S3_BUCKET` (empty: off), `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_PREFIX` (`COMPOSE_PROJECT_NAME`), `BACKUP_S3_PROVIDER` (rclone's provider name) |
| Container logs (Compose) | `DOCKER_LOG_DRIVER` (`local`; `json-file` for a shipper reading Docker's files), `DOCKER_LOG_MAX_SIZE` (20m), `DOCKER_LOG_MAX_FILE` (5): per container |
| Example feature | `NOTE_PUBLISH_DELAY`, `EXAMPLE_SENDER_WEBHOOK_SECRET` |

## First setup: pnpm setup

`pnpm setup` is the wizard for a new project: it asks the few questions that
shape it and writes the env file from the template, so most toggles stay off
and no secret is made by hand (`tools/setup/`: `setup.mjs` asks and writes,
`plan.mjs` maps answers to variables, `envfile.mjs` merges them into the
template's text, keeping its comments, order and unknown keys).

- **Target:** `development` writes `apps/api/.env.development` (from
  `env.development.example`), `production` the root `.env` (from
  `env.example`, chmod 600).
- **The deployment shape is chosen here, once:** `TENANCY` (one organization
  or many; [tenancy.md](tenancy.md), "Single-tenant deployments"), and with
  `single` and sign-up on, `SIGN_UP_ROLES`. Then self sign-up
  (`AUTH_SIGN_UP`; with `multi`, whether a sign-up makes its own tenant:
  `TENANT_SIGN_UP`), mail (`MAIL_TRANSPORT` and its address or key), storage
  (`STORAGE_DRIVER`, S3), bot protection (`CAPTCHA_MODE` and the Turnstile keys,
  only when chosen), passkeys (`PASSKEYS`; the relying party id defaults to
  the web app's host and can never change), social sign-in, exchange rates,
  PDF documents, metrics, the deployment switches ([below](#deployment-switches)):
  `IDEMPOTENCY` (`required` or `optional`), the optional platform services
  `WEBHOOKS`, `REPORTS`, `USAGE`, `REALTIME` (asked in a row, default on), and the
  security switches `AUTH_MFA`, `API_CLIENTS` (default on) and `IMPERSONATION`
  (a privileged support tool, default off; development's template turns it on and
  that is its default); in production also `APP_DOMAIN`, `ACME_EMAIL`,
  `CLOUDFLARE_API_TOKEN`, `WEB_URL`, `CORS_ORIGINS`, the administrator and the
  first tenant. It asks only what the target's template has variables for.
- **Secrets are generated** as `env.example` says (passwords `openssl rand
-hex 24`, keys `-base64 32`) and never printed: the first
  administrator's password is `ADMIN_PASSWORD` in the file it wrote.
- **The example feature:** the last question removes `notes`
  (`pnpm feature:remove notes`, the API's and the web app's part; default
  yes in production); then run `pnpm db:generate`, `pnpm client:generate`
  and `pnpm build`.
- **Re-running** reads the existing file for its defaults, keeps its secrets
  (`--rotate` makes new ones: keys are put in front of the old ones, so old
  data stays readable), shows the changes masked, asks before writing and
  keeps the old file as `<file>.bak`. A changed `TENANCY` or `PASSKEY_RP_ID`
  is warned about.
- **Without a terminal:** `--yes` takes the defaults and the flags (one per
  question, `pnpm setup --help`; a required one missing is an error naming
  it), `--dry-run` prints the plan and writes nothing.

```bash
pnpm setup --yes --target production --app-domain api.example.com --acme-email ops@example.com \
  --cloudflare-api-token <token> --tenancy single --mail smtp --smtp-url <url> --mail-from <from> --no-passkeys
```

## Deployment switches

Platform modules not every project needs. Each is `on` by default, so nothing
changes until it is turned off; the committed OpenAPI document and typed
client are made with all on. They are read when the app is built (a change
needs a restart), validated at boot (a typo stops the app), and `off` leaves
the module's routes, workers and jobs out with no error at boot. An absent
route answers the app's ordinary 404 problem.

| Switch | Off means |
| --- | --- |
| `WEBHOOKS` | No `/v1/webhook-endpoints` or delivery API, no delivery worker and no delivery retention job. The webhooks package stays registered (notifications, approvals and incoming receivers use it), so incoming webhooks work as before, and the outbox relay keeps running: notification delivery goes through it. Deliveries already queued for existing endpoints wait until it is turned on again. |
| `REPORTS` | No `/v1/reports` and no hourly runner; exports and imports are untouched. The `reports` table stays (migrations are not switched); existing reports stop running and are left out of an account's personal-data export. |
| `USAGE` | No metering and no quota enforcement: `UsageInterceptor` is not registered, so nothing is counted on the hot path, the nightly roll-up and `GET /v1/access/clients/{id}/usage` are gone, and a client's `dailyQuota` can still be set but **does not apply** (no `429 quota_exceeded`, no `X-Quota-*` headers). |
| `REALTIME` | No `/realtime` gateway and no socket.io Redis adapter. Everything that pushes (notifications, bulk and export progress, documents, approvals) keeps working: notifications are still stored and mailed, only the live event is dropped. |

The environment is also the **ceiling of the auth policies** a tenant's
administrators set at runtime (`auth.requireMfa`, `auth.passwordMinLength`):
a setting only tightens what the env allows, never loosens it
(`AUTH_MFA=off` and `auth.requireMfa` can't be on). See
[auth.md](auth.md#policies) and [settings.md](settings.md#iams-auth-policies-auth).

There is no `WORKFLOWS` switch: approvals (and the notes example) start and
signal workflows unconditionally, so the workflow engine is part of the core
of the platform, not an optional module.

Features that depend on a switched-off module must not fail because of it:
inject `Realtime` and `Webhooks` as before (they exist either way: `Realtime`
then does nothing, and webhook deliveries to endpoints created earlier wait
in the queue); a feature that calls the reports or usage services directly
should not (nothing else in the template does).

## Which switches are on: `GET /v1/features`

A client (the web app) hides what a deployment turned off by asking
`GET /v1/features`: any signed-in caller (session, token or API client), no
permission needed. It answers what the routes do, because each value is read
the way its module reads it (`FeaturesService`, `platform/features/`):

```json
{
  "realtime": true,
  "webhooks": true,
  "reports": true,
  "usage": true,
  "impersonation": false,
  "mfa": true,
  "apiClients": true,
  "passkeys": true,
  "signUp": false,
  "magicLink": true,
  "documents": false,
  "tenancy": "multi",
  "locales": ["en", "de", "ar", "zh", "ms"]
}
```

| Key                                        | Variable                                                                   | Off means                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `realtime`, `webhooks`, `reports`, `usage` | `REALTIME`, `WEBHOOKS`, `REPORTS`, `USAGE` ([above](#deployment-switches)) | the module's routes are absent (404)                                                                   |
| `impersonation`, `mfa`, `apiClients`       | `IMPERSONATION`, `AUTH_MFA`, `API_CLIENTS`                                 | their routes answer 404 `feature_off`                                                                  |
| `passkeys`, `signUp`, `magicLink`          | `PASSKEYS`, `AUTH_SIGN_UP`, `AUTH_MAGIC_LINK`                              | as in `GET /v1/auth/methods` (which also lists the providers and bot protection, and needs no sign-in) |
| `documents`                                | `GOTENBERG_URL` set                                                        | PDF routes answer 503 `documents_unavailable`                                                          |
| `tenancy`                                  | `TENANCY`                                                                  | `single`: the first tenant is the only one                                                             |
| `locales`                                  | `LOCALES`                                                                  | the languages the API answers in, the first is the default                                             |

The values are fixed at startup (a change needs a restart). A new switch
adds its key to `features.schemas.ts` and `FeaturesService`, reading it the
way its module does.

## Secrets

The variables that hold secrets are declared with `secret()` in their group's
`*.env.ts` (`secret(optional())`). `SECRET_VARIABLES` (`apps/api/src/env.ts`)
lists them, and the logs mask a value under any of these names
([deployment.md](deployment.md), "Log redaction"). A new secret gets
everything below by being declared with `secret()`.

**From a file.** For each secret `X`, `X_FILE` names a file holding its value
(a Docker secret at `/run/secrets/x`, a mounted Kubernetes secret, a file a
vault agent writes). `apps/api/src/core/config/secret-files.ts` reads the
files as the first step of the schema, before anything is validated, so every
module gets the value through `ConfigService` as usual, and `process.env`
holds it too (for code that reads it directly).

- The file's trailing line breaks (`\n`, `\r\n`) are dropped; line breaks
  inside it stay (a PEM block).
- `X` stays the fallback: without `X_FILE` (or with it empty), `X` is used.
- Both set is an error: `X and X_FILE are both set: keep one`. So is a file
  that is missing, unreadable or empty: the error names `X_FILE`, the path
  and the code (`ENOENT`, `EACCES`, `EISDIR`).
- No validation error shows a value, a file's contents included: the
  messages say what was expected, never what was received. File problems and
  the other variables' errors are reported together, in one start.
- A `*_FILE` variable that reads nothing (`JWT_SECERT_FILE`, `PORT_FILE`) is
  ignored, with a warning naming it.
- A relative path resolves against the app's directory (`apps/api`, `/app` in
  the image). `node dist/migrate` reads `DATABASE_URL_FILE`,
  `DATABASE_OWNER_URL_FILE`, `POSTGRES_MONITOR_PASSWORD_FILE` and
  `POSTGRES_REPORTING_PASSWORD_FILE` the same way.

| Secret | What it is | Rotating it |
| --- | --- | --- |
| `DATABASE_URL` | the app role's URL, with its password | Change `POSTGRES_APP_PASSWORD` (or the password in `DATABASE_URL` / `DATABASE_URL_FILE`) and redeploy: `migrate` sets the role's password from the URL when the current one fails ([deployment.md](deployment.md), "Database roles"), then api and worker start on it. |
| `POSTGRES_MONITOR_PASSWORD` | the monitoring role's password (`migrate` sets it, the PostgreSQL exporter connects with it; `compose.monitoring.yaml`) | Change it (or `POSTGRES_MONITOR_PASSWORD_FILE`'s contents) and redeploy: `migrate` sets the role's password when the current one fails, then recreate `postgres-exporter`. |
| `POSTGRES_REPORTING_PASSWORD` | the reporting role's password (`migrate` sets it; platform analytics connect with it) | Change it (or `POSTGRES_REPORTING_PASSWORD_FILE`'s contents) and redeploy: `migrate` sets the role's password when the current one fails; then the BI tool's connection. |
| `DATABASE_OWNER_URL` | the owner's URL, with its password (`migrate` only) | Change the owner's password (`ALTER ROLE app PASSWORD '…'` in `psql`), then the URL (and `POSTGRES_PASSWORD`, or both files), then recreate `migrate` and `backup`. `POSTGRES_PASSWORD` only sets the password when the database is created: changing it alone changes nothing. |
| `REDIS_URL`, `REDIS_PASSWORD` | Redis' password | Change it for the server and the app together (Compose: one file, `REDIS_PASSWORD_FILE`), recreate both: clients reconnect, jobs wait, a few seconds of errors. |
| `JWT_SECRET` | signs the access tokens (HS256, one key), and, through a key derived from it (HKDF, its own label), the account-deletion mail's cancel links | Replace it and recreate the app: access tokens (15 minutes) signed with the old one are refused, clients use their refresh tokens. Cancel links already mailed stop working too: those users sign in and cancel (`DELETE /v1/account/deletion`). |
| `MFA_ENCRYPTION_KEYS` | encrypts TOTP secrets; a list, newest first | Add a new key in front; keep every older one, which still decrypts the secrets sealed with it. Removing one locks its users out of their authenticator until a re-encryption exists (roadmap item 5). |
| `STORAGE_SIGNING_KEYS` | signs file URLs; a list, newest first | Add a new key in front; drop the old one once the URLs it signed have expired (report links last up to `REPORT_LINK_TTL`, at most 7 days). |
| `IDEMPOTENCY_KEYS` | seals stored idempotent responses; a list, newest first | Add a new key in front; drop the old one once the responses it sealed have expired. |
| `CURSOR_KEYS` | seals sorted lists' cursors (`nextCursor`: the last row's sort values, which may be fields the caller can't see; core/http/cursor-seal.ts); a list, newest first | Add a new key in front; drop the old one when cursors handed out with it may fail (a client paging at that moment gets a 400 and starts again from the first page). |
| `WEBHOOKS_ENCRYPTION_KEYS` | encrypts webhook endpoint secrets; a list, newest first | Add a new key in front; keep the old one while endpoint secrets sealed with it remain (rotating an endpoint's secret, `POST /v1/webhook-endpoints/{id}/rotate-secret`, seals it with the newest key). |
| `EXAMPLE_SENDER_WEBHOOK_SECRET` | verifies the example sender's webhooks (one secret) | Agree on a moment with the sender: change it on both sides; deliveries signed with the old one in between are refused and retried by the sender. |
| `ADMIN_PASSWORD` | the first administrator's, on the first start only | Nothing to rotate: change the password in the app, then remove the variable or file. |
| `METRICS_TOKEN` | Prometheus' bearer token for `/metrics` | Change it for the app and Prometheus at once; scrapes in between get a 401. |
| `TURNSTILE_SECRET_KEY` | verifies challenge tokens with Cloudflare (one key per widget) | Turnstile has no second key per widget: rotate it in the dashboard, put it in place and recreate the app; verifications in between fail as an outage (`CAPTCHA_ON_ERROR`). Or create a second widget with the same hosts, switch both keys, then delete the old one. |
| `SMTP_URL`, `MAIL_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | credentials of an outside service | Create a new credential at the provider (most allow two at once), put it in place, recreate the app, then revoke the old one. Where only one can exist (an SMTP password), the swap is a moment of failed sends, which the mail queue retries. |

Outside the app (Compose, [deployment.md](deployment.md), "Secrets in files"):
`POSTGRES_PASSWORD` (PostgreSQL, the backup), `POSTGRES_MONITOR_PASSWORD` (`migrate`, the PostgreSQL exporter), `REDIS_PASSWORD`
(Redis, the exporter), `CLOUDFLARE_API_TOKEN` (Caddy:
create a new token, swap, recreate `caddy`, revoke the old) and
`BACKUP_S3_SECRET_ACCESS_KEY` (like any provider credential) take a `_FILE`
too. Keys the app created itself are in the `app_secrets` table: moving one to
a file means copying its value first (`select value from app_secrets where
name = 'STORAGE_SIGNING_KEYS'`), or the data sealed with it can't be read.
