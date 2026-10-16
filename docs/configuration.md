# Configuration

Every variable is validated at startup (`apps/api/src/env.ts` merges each group's
`*.env.ts`): a missing or malformed one stops the app with its name, never its
value. Every secret can come from a file instead ([Secrets](#secrets)). Read
them with `ConfigService<GroupEnv, true>` (`config.get('PORT', { infer: true })`).

- Production: `.env` is Docker Compose's file (`cp env.example .env`, then
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
  `STORAGE_SIGNING_KEYS`, `IDEMPOTENCY_KEYS`, the incoming webhook secrets.
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
| Runtime | `NODE_ENV`, `APP_ENV` (the deployment's name), `APP_ROLE` (`all`/`api`/`worker`), `PORT`, `SERVICE_NAME`, `OPENAPI` |
| URLs | `APP_URL` (this API), `WEB_URL` (the web app, for email links), `CORS_ORIGINS` |
| Database | `DATABASE_URL` (required, PostgreSQL 18+, the app role), `DATABASE_OWNER_URL` (the owner: `migrate`, and the app when `MIGRATE_ON_START` is on), `MIGRATE_ON_START`, `DATABASE_POOL_MAX` (10), `DATABASE_POOL_TIMEOUT_MS` (5000), `DATABASE_STATEMENT_TIMEOUT_MS` (30000), `DATABASE_IDLE_TX_TIMEOUT_MS` (60000); Compose: `POSTGRES_USER` (`app`, the owner), `POSTGRES_PASSWORD`, `POSTGRES_APP_USER` (`app_runtime`), `POSTGRES_APP_PASSWORD`, `POSTGRES_DB` (`app`), `API_DATABASE_POOL_MAX` (10), `WORKER_DATABASE_POOL_MAX` (20), `POSTGRES_MAX_CONNECTIONS` (100) |
| Redis | `REDIS_URL`, `REDIS_PASSWORD` (replaces the URL's: for one in a file), `REDIS_SENTINELS`, `REDIS_SENTINEL_NAME`, `REDIS_PREFIX`, `RATE_LIMIT_STORE` |
| Logs and traces | `LOG_FORMAT`, `LOG_LEVEL`, `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` |
| Metrics | `METRICS_TOKEN` (Prometheus' bearer token for `GET /metrics`, at least 16 characters; unset: 404; [deployment.md](deployment.md), "Metrics") |
| Alerting (`compose.monitoring.yaml`, optional) | `ALERT_EMAIL_TO`, `ALERT_SMTP_URL` (default: `SMTP_URL`), `ALERT_SMTP_REQUIRE_TLS` (true), `ALERT_EMAIL_FROM` (default: `MAIL_FROM`), `ALERT_WEBHOOK_URL`, `ALERT_SLACK_WEBHOOK_URL`; `PROMETHEUS_PORT` (9090), `ALERTMANAGER_PORT` (9093), both on 127.0.0.1; `PROMETHEUS_CPUS` (0.5), `PROMETHEUS_MEMORY` (1G), `ALERTMANAGER_CPUS` (0.25), `ALERTMANAGER_MEMORY` (128M); [deployment.md](deployment.md), "Alerting" |
| Languages and time | `LOCALES`, `APP_TIMEZONE` |
| Mail | `MAIL_TRANSPORT`, `MAIL_FROM`, `SMTP_URL`, `MAIL_API_KEY`, `MAIL_DIRECTORY` (`.data/mail`), `SES_ENDPOINT` (Floci) |
| Background | `SCHEDULER`, `OUTBOX_RELAY`, `WEBHOOKS_WORKER`, `BULK_SYNC_LIMIT` (100: bulk runs of up to this many ids answer in the request, larger ones are queued) |
| Notifications | `NOTIFICATIONS_DIGEST_HOUR` (8: daily digests, in each user's time zone), `NOTIFICATIONS_RETENTION_DAYS` (90: read ones), `NOTIFICATIONS_MAX_AGE_DAYS` (365: any) |
| Attachments | `ATTACHMENT_MAX_MB` (25), `ATTACHMENT_ALLOWED_TYPES` (comma-separated MIME types, detected from the bytes; default: JPEG, PNG, GIF, WebP, PDF, docx, xlsx, pptx, plain text, CSV, zip) |
| Password hashing | `PASSWORD_HASH_CONCURRENCY` (2; Compose: `API_PASSWORD_HASH_CONCURRENCY` 2, `WORKER_PASSWORD_HASH_CONCURRENCY` 1), `PASSWORD_HASH_MAX_QUEUE` (20), `PASSWORD_HASH_QUEUE_TIMEOUT_MS` (5000): past them, 503 `server_busy`; the memory limit holds the heap plus 128 MiB per hash, [deployment.md](deployment.md#resource-limits) |
| Breached passwords | `PASSWORD_BREACH_CHECK` (`on`), `PASSWORD_BREACH_API_URL` (`https://api.pwnedpasswords.com`, or a mirror), `PASSWORD_BREACH_TIMEOUT_MS` (2000), `PASSWORD_BREACH_ON_ERROR` (`allow`: fail-open; `reject`: 503), `PASSWORD_BREACH_MIN_COUNT` (1); [auth.md](auth.md#passwords) |
| Accounts (self-service) | `ACCOUNT_DELETION_GRACE_DAYS` (14: until a requested deletion is carried out) |
| API usage | `USAGE_RETENTION_DAYS` (400: API clients' daily usage, [usage.md](usage.md)) |
| Revisions | `REVISIONS_RETENTION_DAYS` (365: record revisions; each record's latest stays, [revisions.md](revisions.md)) |
| Money | `EXCHANGE_RATES_FETCH` (`on`: the ECB's reference rates every working day), `EXCHANGE_RATES_ECB_URL` (`https://www.ecb.europa.eu/stats/eurofxref`, or a mirror); [money.md](money.md) |
| Scheduled reports | `REPORT_LINK_TTL` (`24h`: how long a report mail's download link works, at most `7d`; [reports.md](reports.md)) |
| Accounts | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_COOKIE_SECURE`, `AUTH_SIGN_UP`, `AUTH_MAGIC_LINK`, `JWT_SECRET`, `MFA_ENCRYPTION_KEYS`, `MFA_ISSUER`, `IMPERSONATION_TTL_MINUTES`, `REAUTHENTICATION_MAX_AGE_MINUTES` (10: how long a sign-in counts for the sensitive routes), `AUDIT_RETENTION_DAYS`, `SOFT_DELETE_RETENTION_DAYS` (30: the recycle bins) |
| Bot protection | `CAPTCHA_MODE` (`off`; `always`, `after-failures`), `CAPTCHA_PROVIDER` (`turnstile`; `stub` for tests and load tests, refused in production), `TURNSTILE_SITE_KEY` (public), `TURNSTILE_SECRET_KEY`, `CAPTCHA_VERIFY_URL` (Cloudflare's siteverify), `CAPTCHA_HOSTNAMES` (the widget's hosts; default: `WEB_URL`'s), `CAPTCHA_TIMEOUT_MS` (2000), `CAPTCHA_ON_ERROR` (`allow`: fail-open under `CAPTCHA_DEGRADED_LIMIT` (2) per address in the window; `reject`: 503), `CAPTCHA_FAILURES` (3), `CAPTCHA_FAILURES_WINDOW_MINUTES` (15); [auth.md](auth.md#bot-protection) |
| Sign in with | `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_TENANT_ID/CLIENT_ID/CLIENT_SECRET`, `GITHUB_CLIENT_ID/SECRET` (redirect URI: `<APP_URL>/v1/auth/oidc/<provider>/callback`) |
| Files | `STORAGE_DRIVER` (`local`/`s3`), `STORAGE_ROOT` (`.data/storage`), `STORAGE_SIGNING_KEYS`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` |
| AWS (S3, SES) | `AWS_REGION` (also S3's default region), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; unset keys: the packages read `process.env` |
| Platform keys | `IDEMPOTENCY_KEYS`, `WEBHOOKS_ENCRYPTION_KEYS`, `WEBHOOKS_ALLOW_LOOPBACK` (development only) |
| Compose | `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `APP_IMAGE` (unset: built from the checkout; a published image: [deployment.md](deployment.md), "Publishing and rolling back images"), `API_REPLICAS`, `WORKER_REPLICAS`, `API_CPUS`, `API_MEMORY` (768M), `API_HEAP_MB` (384), `API_PASSWORD_HASH_CONCURRENCY` (2), `WORKER_CPUS`, `WORKER_MEMORY` (1G), `WORKER_HEAP_MB` (768), `WORKER_PASSWORD_HASH_CONCURRENCY` (1), `POSTGRES_CPUS`, `POSTGRES_MEMORY`, `REDIS_PASSWORD`, `REDIS_CPUS`, `REDIS_MEMORY`, `REDIS_MAXMEMORY` (the PostgreSQL roles: the Database row) |
| Caddy | `APP_DOMAIN`, `CLOUDFLARE_API_TOKEN`, `ACME_EMAIL` |
| Backups (Compose, [deployment.md](deployment.md), "Backups and restore") | `BACKUP_SCHEDULE` (`0 3 * * *`, cron, UTC), `BACKUP_RETENTION_DAYS` (14: in the `backups` volume), `BACKUP_MAX_AGE_HOURS` (25: older, a catch-up runs and the service turns unhealthy), `BACKUP_CPUS` (0.5), `BACKUP_MEMORY` (512M); off the host, all optional: `BACKUP_S3_BUCKET` (empty: off), `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_PREFIX` (`COMPOSE_PROJECT_NAME`), `BACKUP_S3_PROVIDER` (rclone's provider name) |
| Container logs (Compose) | `DOCKER_LOG_DRIVER` (`local`; `json-file` for a shipper reading Docker's files), `DOCKER_LOG_MAX_SIZE` (20m), `DOCKER_LOG_MAX_FILE` (5): per container |
| Example feature | `NOTE_PUBLISH_DELAY`, `EXAMPLE_SENDER_WEBHOOK_SECRET` |

## Secrets

The variables that hold secrets are declared with `secret()` in their group's
`*.env.ts` (`secret(optional())`). `SECRET_VARIABLES` (`apps/api/src/env.ts`)
lists them. Nothing redacts logs with it yet; that is roadmap item 23. A new
secret gets everything below by being declared with `secret()`.

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
  the image). `node dist/migrate` reads `DATABASE_URL_FILE` and
  `DATABASE_OWNER_URL_FILE` the same way.

| Secret | What it is | Rotating it |
| --- | --- | --- |
| `DATABASE_URL` | the app role's URL, with its password | Change `POSTGRES_APP_PASSWORD` (or the password in `DATABASE_URL` / `DATABASE_URL_FILE`) and redeploy: `migrate` sets the role's password from the URL when the current one fails ([deployment.md](deployment.md), "Database roles"), then api and worker start on it. |
| `DATABASE_OWNER_URL` | the owner's URL, with its password (`migrate` only) | Change the owner's password (`ALTER ROLE app PASSWORD '…'` in `psql`), then the URL (and `POSTGRES_PASSWORD`, or both files), then recreate `migrate` and `backup`. `POSTGRES_PASSWORD` only sets the password when the database is created: changing it alone changes nothing. |
| `REDIS_URL`, `REDIS_PASSWORD` | Redis' password | Change it for the server and the app together (Compose: one file, `REDIS_PASSWORD_FILE`), recreate both: clients reconnect, jobs wait, a few seconds of errors. |
| `JWT_SECRET` | signs the access tokens (HS256, one key) | Replace it and recreate the app: access tokens (15 minutes) signed with the old one are refused, clients use their refresh tokens. |
| `MFA_ENCRYPTION_KEYS` | encrypts TOTP secrets; a list, newest first | Add a new key in front; keep every older one, which still decrypts the secrets sealed with it. Removing one locks its users out of their authenticator until a re-encryption exists (roadmap item 5). |
| `STORAGE_SIGNING_KEYS` | signs file URLs; a list, newest first | Add a new key in front; drop the old one once the URLs it signed have expired (report links last up to `REPORT_LINK_TTL`, at most 7 days). |
| `IDEMPOTENCY_KEYS` | seals stored idempotent responses; a list, newest first | Add a new key in front; drop the old one once the responses it sealed have expired. |
| `WEBHOOKS_ENCRYPTION_KEYS` | encrypts webhook endpoint secrets; a list, newest first | Add a new key in front; keep the old one while endpoint secrets sealed with it remain (rotating an endpoint's secret, `POST /v1/webhook-endpoints/{id}/rotate-secret`, seals it with the newest key). |
| `EXAMPLE_SENDER_WEBHOOK_SECRET` | verifies the example sender's webhooks (one secret) | Agree on a moment with the sender: change it on both sides; deliveries signed with the old one in between are refused and retried by the sender. |
| `ADMIN_PASSWORD` | the first administrator's, on the first start only | Nothing to rotate: change the password in the app, then remove the variable or file. |
| `METRICS_TOKEN` | Prometheus' bearer token for `/metrics` | Change it for the app and Prometheus at once; scrapes in between get a 401. |
| `TURNSTILE_SECRET_KEY` | verifies challenge tokens with Cloudflare (one key per widget) | Turnstile has no second key per widget: rotate it in the dashboard, put it in place and recreate the app; verifications in between fail as an outage (`CAPTCHA_ON_ERROR`). Or create a second widget with the same hosts, switch both keys, then delete the old one. |
| `SMTP_URL`, `MAIL_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | credentials of an outside service | Create a new credential at the provider (most allow two at once), put it in place, recreate the app, then revoke the old one. Where only one can exist (an SMTP password), the swap is a moment of failed sends, which the mail queue retries. |

Outside the app (Compose, [deployment.md](deployment.md), "Secrets in files"):
`POSTGRES_PASSWORD` (PostgreSQL, the backup, the exporter), `REDIS_PASSWORD`
(Redis, the exporter), `CLOUDFLARE_API_TOKEN` (Caddy:
create a new token, swap, recreate `caddy`, revoke the old) and
`BACKUP_S3_SECRET_ACCESS_KEY` (like any provider credential) take a `_FILE`
too. Keys the app created itself are in the `app_secrets` table: moving one to
a file means copying its value first (`select value from app_secrets where
name = 'STORAGE_SIGNING_KEYS'`), or the data sealed with it can't be read.
