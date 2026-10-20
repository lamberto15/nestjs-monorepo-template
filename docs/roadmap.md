# Roadmap

What the template builds next, in order. Version 2 (2026-10-16): the approved v1 list
(items 0–17, Kubernetes excluded for now) after an independent edge-case review by
Claude Fable 5.1. Every review finding that cites code was re-checked against `main` at
7676b43; where this plan departs from the review is listed at the end. Each item is
built in its own worktree and pull request ([development](development.md), "Git
workflow"); big items get two independent reviews before merging. Update the Status
table as items merge. PR numbers up to #46 are the private archive's
(nestjs-backend-template); rows marked "here" name this repository's PRs.

## Early stage: breaking changes are accepted

The owner's call (2026-10-16): while the template has no adopters, existing modules,
tables, routes and the typed client may change incompatibly whenever that gives the
more scalable model. Pick the right design, not the compatible one.

What still holds:
- migrations are generated, never hand-written;
- app10's data is reset at the breaking migrations (owner's answer);
- every break is listed in the PR.

Expand/contract (20) and oasdiff (21) protect adopters. They become blocking once the
first project is built on the template; until then they report only.

## Status

| Item | State |
| --- | --- |
| 0. First-boot seeding race | **Done** (#29): one transaction, `pg_advisory_xact_lock`, re-checks under the lock, one `user.seeded` audit entry (actor `system:seed` since #38), breach warning after commit. Seeding stays in every role (safe under the lock). |
| Approvals | **Done** (#27), so tenancy no longer lands on a half-built module. |
| 18. System principal | **Done** (#38): `system:<job>` principals of declared jobs (`defineSystemJob()`, never `all.manage`), `SystemContext.run()` (CLS context + transaction; 1a adds the tenant), the seeder, every cron job, the notification delivery and the workflows' steps moved onto it; `PrincipalGuard` refuses it over HTTP and sockets. docs/permissions.md, "The system principal". |
| 1a, part 1. Database roles | **Done** (#36): `migrate` connects as the owner (`DATABASE_OWNER_URL`), api and worker as `app_runtime` (NOSUPERUSER NOBYPASSRLS, owns nothing, DML only, no role memberships), created and checked by `roles.ts` on every migrate. Tests run as the app role over scram. The rest of 1a: the next row. |
| 10, part 1. Git hooks | **Done** (#33): lefthook (Prettier, oxlint, commitlint) and the PR-title check in CI. Demo seed and devcontainer: the 10 row below. |
| 16a. Dead-man's switch and certificate probe | **Done** (#32). Off until the owner sets `ALERT_WATCHDOG_URL_FILE` (healthchecks.io ping URL). |
| 16b. Host monitoring | **Done** (#256): node-exporter and six `host` alerts in `compose.monitoring.yaml`; an hourly outside probe workflow, off until the `UPTIME_PROBE_URL` variable is set. docs/deployment.md, "Alerting". |
| 19. Secrets | **Done** (#35): every secret can come from `X_FILE`; Docker secrets in production Compose; Redis' password never on a command line. Follow-up: a `pg_monitor` role for the exporter. |
| 20. Expand/contract migrations | **Done** (#34): the policy in docs/pitfalls.md and squawk's lint in CI (report-only until `MIGRATION_LINT_FAIL` is set; changed merged migrations always fail). |
| 21. OpenAPI breaking changes | **Done** (#31): oasdiff in CI, report-only until `OASDIFF_FAIL_ON` is set. |
| 24. Session method and step-up | **Done** (#37): the session records how it was signed into; `@RecentAuthentication()` on sensitive routes, `POST /v1/auth/reauthenticate`. Follow-ups: a no-sign-in cancel link in the deletion mail; per-request `prompt=login` for OIDC. |
| 4. Bot protection | **Done** (#42): Cloudflare Turnstile behind a `CaptchaVerifier` interface, `@Captcha()` on sign-in, sign-up, the magic-link request and forgot password, the token in `X-Captcha-Token`; modes `off` (default), `always`, `after-failures` (per address and per email and address, the same for unknown accounts); 2 s timeout and a circuit breaker (@nestjs/resilience); fail-open under a strict tier with a metric, an alert and a replay set, fail-closed configurable; the token sign-in of native apps shares the counters and the challenge (a web view when asked); the stub verifier for tests and load tests, refused in production. docs/auth.md, "Bot protection". Follow-ups: the widget in the frontend starter (7); app attestation for the token sign-in. |
| 14. Money and currency | **Done** (#41): `Money` (bigint minor units, ISO 4217 exponents, one rounding by a named mode, largest-remainder allocation), `formatMoney()` with an explicit numbering system, `moneyColumns()`; the ECB's daily rates fetched by `system:exchange-rates`, conversion through the euro carrying rate, day and source, `GET /v1/money/rates` and `/convert`, the `ExchangeRatesStale` alert. docs/money.md. |
| 17-lite. Load-test baseline | **Done** (#43): k6 (sign-in, a filtered list, create) on the production stack (`compose.loadtest.yaml`, `loadtest/run.sh`), on a GitHub runner, manual only for now (`workflow_dispatch`, to save Actions minutes; a schedule is one line under `on:`), the `load-test-baseline` artifact, fails at 2× the previous run or the anchor (median, p95, errors, dropped iterations); `RATE_LIMIT_MULTIPLIER` and the `load-test` API client (high quota) instead of disabled limits. docs/development.md, "Load tests". Follow-up: concurrent sign-ins OOM-kill an api replica (four scrypt hashes of 128 MiB pass `API_MEMORY` 512M), so the baseline signs in at 2/s; bound the hashes in flight (done in #4 here). |
| 17-full. Full load tests | **Done** (#255): the export scenario in k6 (queue, worker, storage: the request's latency and the time to a ready file), realtime through Artillery's socket.io engine (`loadtest/realtime.yml`, pinned image), `LOADTEST_REPLICAS` (1 to 6 api replicas), and the bot check's cost (`LOADTEST_CAPTCHA=always`: the stub verifier, which `captcha.providers.ts` allows under `NODE_ENV=production` only with `APP_ENV=loadtest`, unit-tested). Manual only, not in CI. Not measured yet: the delivery latency of a pushed realtime event. docs/development.md, "Load tests". |
| 22. Email deliverability | **Done** (#3 here): `POST /v1/webhooks/mail/ses` verifies SNS notifications (signature versions 1 and 2, certificate URL and `SubscribeURL` restricted to SNS hosts, `SES_SNS_TOPIC_ARNS` allow-list, replay-safe), a queue job as `system:mail-intake` keeps the suppression list (hard/soft bounces with a threshold, complaints, manual entries; `GET/POST/DELETE /v1/mail/suppressions`, audited); the mail worker skips listed recipients (`@EssentialMail()` still reaches an address that complained); entries in the data export and erased with the account; SPF/DKIM/DMARC and the SNS setup in docs/deliverability.md; `MailBounceRateHigh`, `MailComplaints` alerts. Pluggable: Postmark and SendGrid intakes (#240); Resend, Mailgun… as adapters later. |
| 12. Saved views | **Done** (#231): `platform/views`; `saved_views` (a list's `query` and `columns` under a name, private, team or tenant-wide), `GET/POST /v1/views`, `GET/PATCH/DELETE /v1/views/{id}`, `GET /v1/views/{id}/apply`; validated against the list with its custom fields on save and again on apply (stale: 400; a filter, sort or search on a field the viewer may not read: 403 `field_forbidden`; columns they may not see are hidden, not an error); `Access.manageViews` shares with the tenant and changes shared views, team members share with their team; a `PersonalDataSource` (private views go with the account, shared ones become ownerless); audited. Follow-ups: the view picker in the web list pages (`frontend` issue), views as exports' and reports' filters. docs/saved-views.md. |
| 13. PDF generation | **Done** (#5 here): `platform/documents`; features register a `DocumentSource`, `POST /v1/notes/{id}/pdf` answers 202 and `GET /v1/documents/{id}` follows it; the worker renders a template with @nestjs/mail's escaping `FileTemplateEngine` (RTL, Noto fonts for Arabic and CJK, CSP `default-src 'none'`) through a pinned Gotenberg on an `internal: true` network (no JavaScript, private and public IPs denied, read-only, `cap_drop: ALL`), and one transaction adds the `locked` attachment and completes the document; per-run claims make duplicate runs safe; the attachment records the fields it shows, and a reader must see all of them; realtime `document.ready` and `document.failed`; off (503 `documents_unavailable`) without `GOTENBERG_URL`; the scanned image is published to GHCR. docs/documents.md. |
| 15. AI helper | **Done** (#237): `platform/ai`; features register an `AiSource` (`NoteAi`), `POST /v1/ai/runs` answers 202 and `GET /v1/ai/runs/{id}` follows it; an `ai` queue worker (`lockDuration` above the call's timeout) asks an `AiProvider` (Anthropic adapter, forced tool call with a Zod-validated schema; off without `ANTHROPIC_API_KEY`, per tenant until `ai.enabled`); the record's fields are those the requester may read; `ai_runs` stores model id, prompt version and tokens (no prompt, no output); cache keyed by tenant, model, prompt version; daily tenant token cap (429 `ai_quota_exceeded`); realtime `ai.ready`/`ai.failed`. Not done: streaming over realtime, redaction through item 5's column registry (PR #337, unmerged). docs/ai.md. |
| Password-hash OOM fix | **Done** (#4 here): `PasswordHashLimiter` (a `BulkheadPolicy` of @nestjs/resilience) caps the scrypt hashes in flight (`PASSWORD_HASH_CONCURRENCY`, default 2; then a queue bounded by `PASSWORD_HASH_MAX_QUEUE` and `PASSWORD_HASH_QUEUE_TIMEOUT_MS`, then 503 `server_busy` with `Retry-After`); re-entrant, so a busy password reset leaves its link working; `API_MEMORY` 768M; `password_hashes_*` metrics and the `PasswordHashingSaturated` alert. Hash parameters unchanged. docs/deployment.md, "Resource limits". |
| 1a. Tenancy core | **Done** (#14 here): `tenants`, global users with `memberships`; `tenant_id NOT NULL` (no default) on every other table, per-tenant uniques, composite `(tenant_id, x)` keys; RLS declared in Drizzle on 28 tables (four policies each, FORCE and the policy set checked by `roles.ts` on every migrate); `TenantPool` sends `set_config(…, true)` with each `begin`, wraps tenant-table reads outside a transaction, refuses a statement without a tenant before a connection is taken; the tenant from the session (`POST /v1/auth/tenant` switches, refused while impersonating), the token's `tid`, the API client, `TenantEnvelope` on jobs, outbox and workflows; cron through `forEachTenant()`; sweeps across tenants only as `app_maintenance` (BYPASSRLS, worker and migrate only, never the api); per-tenant idempotency, rooms, caches, sequences, usage, settings scope and `tenants/<id>/` storage; adding people is invite-only (decision below); verify-first sign-up; the operator tenant guards ops, suppressions and `/v1/tenants`. Load test: list +33 %, create +27 % on the median, under the 2× bar. docs/tenancy.md. |
| 3. Passkeys | **Done** (#12 here): @simplewebauthn/server; register, list, rename, remove (`/v1/auth/passkeys`); sign-in with or without an email, by session or token (`tid`); one-time challenges bound to ceremony, user, session and origin; user verification required, which also completes a pending second factor; forward-only counter, synced passkeys at 0; decoys for unknown addresses; own throttles and `@Captcha()`; the last-sign-in-method check under a row lock; verify-first; refused while impersonating; account-level audit and notifications; `/.well-known/` files for native apps. docs/auth.md, "Passkeys". |
| 9. Release automation | **Done** (#8 here): template releases on `v*` tags with generated notes (breaking changes, images by digest, the migrations since the last tag with the expand/contract lint, rollback, changed variables); changesets for `packages/api-client` (version PR on main, npm publish off); docs/upgrading.md for projects pulling template updates. docs/releases.md. |
| 10. Demo seed and devcontainer | **Done** (#11 here): `pnpm db:seed:demo` makes the "Demo Company" tenant through the services as `system:demo-seed` (generated passwords printed once; refused unless `NODE_ENV` is development or test and the database carries the dev marker); `.devcontainer/` with PostgreSQL (scram), Redis, Mailpit and Gotenberg, e2e reusing them. docs/development.md. |
| 23. Log redaction | **Done** (#9 here): one registry (`core/logging/redaction.ts`) of secret headers, fields and text patterns, fed to Nest's logger `redact`, NestJS Observe and a pass over every line; `secret()` variables and the API key shape declared into it; item 5's column registry extends it. docs/deployment.md, "Log redaction". |
| CodeQL findings | **Done** (#10 here): custom-field patterns run on RE2 (linear time; lookaround and backreferences refused at save), string-only OIDC query parameters, a linear trailing-slash trim in the client. The SHA-1 (Pwned Passwords) and SHA-256 (API keys) alerts are dismissed as false positives, the demo seed's password print as intended. |
| Auth follow-ups | **Done** (#13 here): wrong MFA codes count as sign-in failures for bot protection; Redis 7.0 or newer checked at start; a no-sign-in cancel link in the deletion mail (its own JWT key and type, single use, the nightly job claims a deletion under the account lock); OIDC step-up with `prompt=login`, `max_age=0` and `auth_time`; the exporter connects as a `pg_monitor`-only role. |
| Teams (25) | **Done** (#23 here): org units became teams, a rename only (see item 25). |
| 6. Feature generator | **Done** (#24 to #30 here, then #38, #40, #41, #48, #230): `pnpm feature:add`, `feature:sync`, the `<item>.record.ts` declaration, the `/add-feature` skill; see item 6 + 8 for what is open. docs/adding-a-feature.md. |
| Core without notes | **Done** (#31, #33 here): `pnpm feature:remove notes`; a test-only record (`apps/api/test/fixtures/test-items`) carries the platform's tests; CI's `template-without-notes` job (e2e in two shards, #51). |
| `pnpm setup` and deployment switches | **Done** (#36, #43 here): the first-run wizard (`tools/setup`); `IDEMPOTENCY` (#35), `WEBHOOKS`, `REPORTS`, `USAGE`, `REALTIME` (#37), `AUTH_MFA`, `API_CLIENTS`, `IMPERSONATION` (default off, #39); runtime auth policies `auth.requireMfa` and `auth.passwordMinLength` under the env's ceiling (#44). docs/configuration.md. |
| Zero-downtime deploys | **Done** (#49 to #54 here): Caddy holds requests while replicas restart (#49); `pnpm deploy:rolling` (#53), `pnpm deploy:blue-green` (#52), `pnpm deploy:swarm` (#54); replicas exit right after their last response. docs/deployment.md, "Zero-downtime deploys: three ways". |
| 11. Push and SMS | **Done** (#236; depends on #337): `platform/messaging`; `devices` (encrypted token, blind index; `PUT/GET /v1/devices`, `DELETE /v1/devices/{id}`; removed with the person, when the provider reports the token dead, after `DEVICES_RETENTION_DAYS` unseen, or with the account) and `phone_numbers` (encrypted, blind index; set, texted a six-digit code, verified); `sms` and `push` notification channels that only queue, a `messaging` queue worker that sends; providers behind `SmsProvider` and `PushProvider` (Twilio over `fetch`, Web Push with VAPID, memory for tests), all `off` by default; toll-fraud caps per UTC day (a country-prefix allowlist, per tenant, per prefix and per user, atomic counters, refusals counted and logged), the `messaging.sms` kill switch the operators can force off, `sms_sent_today` and `sms_blocked_today{reason}`; `POST /v1/webhooks/sms/twilio` verifies Twilio's signature and turns STOP and START into opt-out and opt-in (START only re-enables); per-type `sms` and `push` preferences. Not done: APNs and FCM adapters, quiet hours (so urgent messages bypassing them), a per-IP limit beyond the route throttle, a monetary spend cap (the caps count messages), the alert rule on `sms_blocked_today`. docs/notifications.md, "Push and SMS". |
| Fixes of 2026-10-17 | **Done**: a unique field of a soft-delete record is unique among live rows (#47); the record export has a tags column (#34); `RecentSignInGuard` named so the guard-order check passes (#50). |
| 7. Frontend starter | **Mostly built** (#64 to #143 here): `apps/web` and `packages/ui`: sign-in, the account pages, notifications, approvals, the list and record pages, access, API clients, settings, search, the audit log, data transfer and bulk work; what's open is listed in item 7. docs/monorepo.md, "The web app". |
| 5. Personal-data protection, part 1 | **Draft** (#223, the AAD decision pending): `EncryptionService` (AES-256-GCM, `v1.<key id>.<iv>.<ct>.<tag>`, the format version naming the AAD: table + column + tenant), the column registry (`encrypted()`, log redaction by name), blind indexes (HMAC-SHA-256, normalizers, every key's index while rotating), `DATA_ENCRYPTION_KEYS` and `BLIND_INDEX_KEYS` (env or files only, boot refused without them), the hourly re-encryption queue job (batches, compare-and-set writes, `encrypted_rows_on_old_key`). Open: the MFA key out of `app_secrets`, revisions/audit/export/custom fields consulting the registry, retention rules and legal holds. docs/encryption.md. |
| Everything else | Not started. |

### Open follow-ups

- **Tenancy (1b):** sign-ins visible to tenant administrators (**done** (#228): `GET /v1/access/sign-ins`, docs/auth.md, "Sign-in log"); the platform super
  tenant; a membership still active in a deactivated tenant exporting that tenant's
  records (**done** (#220): docs/tenancy.md, "Operators"); the migrate-time wall check
  compares the policies' expressions, roles and kind too (**done** (#221): docs/tenancy.md,
  "The wall"); whether operators may act in any tenant without its invitation (a
  break-glass support route: the owner's decision, docs/tenancy.md, "Operators").
  Tenant export and deletion are done (#226; get, rename and deactivation, #195);
  per-tenant senders for incoming webhooks are done (#234: docs/webhooks-and-realtime.md,
  "Incoming webhooks of a tenant").
- **Passkeys:** token clients with two-factor still send a code with a passkey until
  @nestjs/authentication can take a verified external factor (ask upstream).
- **Load-test anchor:** `main` has none yet; run the Load test workflow on `main` once
  to set it.
- **Owner actions (from #8):** squash commits titled by the PR (`PR_TITLE`); allow
  GitHub Actions to create pull requests; push the first tag, `v0.1.0`.
- **Cleanup (owner's call):** the old checkout `nestjs-backend-template` and the
  `nestjs-template_*` volumes are no longer used by app10.

## Decisions for the owner (recommendation first)

**Answered by the owner, 2026-10-17:** all as recommended.
- Adding people to a tenant is **invite-only**: administrators never set passwords
  or names; an invitation is accepted by its owner (closes the account-sharing
  findings of #14's review).
- An account's export includes only personal data (membership, audit about them)
  from tenants the person has left.
- Who creates tenants: a `TENANT_SIGN_UP` switch in 1b; operators only until then.
  Built (#225): docs/tenancy.md, "Tenants made at sign-up".
- One tenant only: `TENANCY=single` (owner, 2026-10-17): no second tenant, and
  self sign-ups join the one with `SIGN_UP_ROLES`. docs/tenancy.md.
- Token clients with two-factor keep sending a code with a passkey; ask
  @nestjs/authentication upstream.
- Releases: a tag per roadmap item or batch, `v0.x` from `v0.1.0`; 1.0.0 with the
  first adopter.
- The typed client stays unpublished until something outside the repository needs it.
- The demo seed prints its generated passwords once (CodeQL alert dismissed as
  intended).

**Answered by the owner, 2026-10-16:** all as recommended.
- 1: one origin, with the active tenant on the session.
- 2: Vite React SPA.
- 3: AAD = table + column + tenant.
- 4: Docker secrets.
- 5: healthchecks.io. The owner creates the check; until its ping URL is in `.env`, 16a
  ships with the receiver configurable and off.
- 6: tenant + groups.

Also answered: **app10's data is reset** when tenancy lands (it is a demo), rather than
carried over.

1. **How the tenant is resolved (blocks 1a; decides 3's RP ID and 7's cookies).**
   *Recommended:* one origin. The session carries an active tenant, and switching tenant
   re-issues the session. API clients and tokens belong to exactly one tenant. There
   are no subdomains. This keeps `__Host-sid`, one CSRF origin list and one passkey RP
   ID. Tenant subdomains or custom domains can come later as their own item.
2. **Frontend (7):** Vite SPA (TanStack Router and Query, the existing client, shadcn/ui
   and Dice UI) served by Caddy. Next.js is not recommended, because it adds an SSR process.
3. **What encrypted values are bound to (5):** AAD = `table.column` + `tenant_id`. This
   blocks swapping values across tenants and columns, but accepts swaps between rows of
   the same tenant. Binding to the row needs the id before the insert, i.e. app-side
   UUIDv7 instead of the DB `uuidv7()` default. Decide when 5 starts.
4. **Secrets (19):** Docker secrets (files) for single-host Compose, with one
   `SecretsService` that reads file, env, or a KMS later.
5. **External dead-man receiver (16a):** needs an account, e.g. healthchecks.io
   (free tier). The owner creates it and gives the ping URL.

6. **Tenants and groups.** The owner wants companies to group their people (teams,
   departments, divisions, sub-organizations), scope work per group, and still report
   across all their own groups.
   *Recommended:* two layers, never one.
   - The **tenant** is the customer: the contract, billing and legal boundary. It is a
     hard wall, enforced by RLS. A company is one tenant, and all its groups live
     inside it, so company-wide reports never cross a wall.
   - **Groups** (item 25) organize people and data inside a tenant. They are flexible
     and enforced by permissions (CASL), not RLS, so overlapping memberships and
     roll-up reports stay possible.
   - A **holding group** whose subsidiaries must be separate tenants but want
     consolidated reports gets a tenant tree (1b): reads may span the parent's
     subtree for users granted that, while writes always target one tenant.

   The test: a separate customer, whose data must never leak even through a bug, is a
   tenant. A way one customer organizes itself is a group. Never make each team a
   tenant.

Settled: app10 has no public DNS record (`/etc/hosts` points it at 127.0.0.1, see
CLAUDE.md), so no outside probe can reach it; 16a probes from inside the stack.

## Order

| Phase | Items | Why here |
| --- | --- | --- |
| A | **16a** dead-man's switch + certificate probe; **21** oasdiff in CI | An afternoon each; protects the running instance and every later API change |
| B | **17-lite** (sign-in, list, create; nightly, JSON baseline) | The only way to measure what RLS and per-request transactions cost |
| C | **18** system principal; **20** expand/contract policy + destructive-DDL lint | 1a's cron jobs need an actor; 1a's migration is the first big expand/contract |
| D | **1a** tenancy core, then **25** groups | Hardest to add later; sweeps every module once. Groups define what every record is owned by |
| E | **6 + 8** generator and unified event declaration | Tenancy now defines what a feature includes; `notes` becomes the golden output |
| F | **5** encryption service + column registry; **19** secrets; **23** log redaction | 2, 11, 15 all store secrets or PII |
| G | **24** session method + step-up; **3** passkeys; **4** bot protection; then **2** SSO/SCIM | 2 needs 1a, 5, 24 and domain verification |
| H | **1b**; **10** (lefthook before 9); **9**; **22** email deliverability; **7** | Each later auth item adds UI to 7 |
| I | 11, 12, 13, 14, 15, 17-full | By product need; 11 needs 5 |

---

## 1. Multi-tenancy

Split into **1a** (core) and **1b** (per-tenant product features).

### 1a. Design

- **Data model.** A first-class `tenants` table and a `tenant_id` column. It must not be
  modelled as the root org unit (that breaks RLS, uniques and sequences). Users are
  global. A `memberships` table holds (user, tenant, roles). API clients and tokens
  belong to one tenant.
- **Database roles (the big finding).** Today migrate, api and worker all connect as
  `POSTGRES_USER`, which the postgres image creates as a superuser and which owns the
  tables. RLS would be bypassed and every test would still pass. The fix:
  - an owner role for `migrate`;
  - an `app` role (`NOSUPERUSER`, `NOBYPASSRLS`, not the owner) for api and worker;
  - `FORCE ROW LEVEL SECURITY` on tenant tables;
  - policies declared in Drizzle (`pgPolicy`, `pgRole`, `.enableRLS()`; present in
    drizzle-orm 0.45) so `db:generate` emits them.

  *Open:* drizzle-kit doesn't emit `CREATE ROLE`, `GRANT` or `ALTER DEFAULT PRIVILEGES`
  (verify). Do that bootstrap idempotently in `migrate.ts` as code, which is cluster
  setup rather than a schema migration. app10 needs the same step once (no
  init-script re-run).
- **The settings.** Use `set_config(..., true)` at the start of every transaction,
  issued by the transaction adapter. Never a plain `SET`, which outlives the pooled
  connection. There are two settings:
  - `app.tenant_id`: the one tenant writes go to;
  - `app.read_tenants`: the tenants reads may see. It is the same one tenant unless a
    consolidated read (1b) widens it.

  Policies read them once per query through a `(select current_setting(...))`
  subquery:
  - `USING (tenant_id = any(... read_tenants ...::uuid[]))`;
  - `WITH CHECK (tenant_id = ... tenant_id ...::uuid)`.

  A missing setting fails loudly.
- **Reads outside a transaction** go straight to the pool with no setting: they fail
  closed and return nothing. Every read must run in a transaction.
  *Caution:* a single transaction spanning the whole request holds a pool connection
  across Redis, HTTP and S3 awaits. Prefer short transactions per unit of work, plus a
  dev/test assertion that refuses tenant-table access outside one. 17-lite measures the
  choice.
- **Context.** CLS contexts exist today only inside transactions and the approval
  engine's `cls.run`; no middleware is mounted (`core.module.ts:80`). Mount:
  - CLS middleware for HTTP;
  - the CLS guard/interceptor for WebSockets;
  - a wrapper in queue and workflow processors that restores the tenant from the
    payload.
- **Async carries the tenant by type.** `tenantId` is a mandatory field of:
  - job data, through a typed envelope rather than convention;
  - outbox envelopes;
  - workflow inputs and signals.

  Maintenance cron jobs (account deletion, usage roll-up, orphan sweep, audit
  retention, scheduled reports) either iterate tenants or run under a documented
  `app.bypass_rls` setting that only the worker sets. They act as the system
  principal (18) and log the tenant they ran for.
- **Cross-tenant FKs** pass RLS, because FK checks run as the owner. Use composite
  `(tenant_id, id)` FKs, which need a unique `(tenant_id, id)` per table; the generator
  (6) emits them.
- **Per-principal keys** get the tenant in the platform code, not at call sites:
  - idempotency scope (`${kind}:${id}` today: a replay in tenant B returns tenant A's
    response);
  - realtime rooms (`principal:…` today: one socket gets every tenant's events);
  - sequence scopes;
  - a new `tenant` settings scope, with rollouts hashed per tenant;
  - cache keys;
  - an attachment key prefix (`tenants/<id>/…`) from day one, so deletion and export
    are prefix operations.
- **Uniques** become per tenant, except global user identity (email).
- **Impersonation** never crosses tenants.
- **Migration:** app10's database is reset when 1a lands (owner's answer), so
  `tenant_id` is `NOT NULL` from its first generated migration. The column has **no**
  default, so a forgotten tenant fails instead of landing in a default one. The
  nullable → backfill → `NOT NULL` sequence is needed only once a deployment's data
  must survive.

### 1a. Tests

- An e2e test connects **as the app role** and proves that a cross-tenant read returns
  nothing and a cross-tenant insert fails.
- A CI check that the app role is neither a superuser nor the owner.
- A cron job run under RLS does real work (not an empty "success").

### 1b

- Per-tenant settings, flags, quotas and branding.
- The tenant switcher UX.
- Tenant export and deletion: **done** (#226): the operators' export (a data
  transfer, step-up) and deletion (deactivated, a grace period, then a worker erases
  rows, files, queued jobs, workflows and outbox messages). docs/tenancy.md.
- The platform "super tenant" for operators.
- **The tenant tree** for holding groups: **done** (#233): `parent_id` on `tenants`
  and the `tenant_closure` table, placed by the operators (a cycle refused); a user
  with `Access.readConsolidated` reads the parent's active subtree, read-only, audited
  in every tenant read (`TenantTree.consolidated()`, the consolidated audit log); the
  read policies check the tree too, so a child never reads its parent or a sibling.
  docs/tenancy.md, "The tenant tree". Open: consolidated exports and the features'
  own consolidated reports (each calls `TenantTree.consolidated()`).
  - Writes and everything else stay in one tenant.
- Platform analytics across unrelated tenants never go through the app role. They use
  a separate reporting role on anonymized aggregates: **done** (#235): the worker's
  nightly `PlatformAnalyticsJob` stores suppressed counts in the `analytics` schema,
  the only one `POSTGRES_REPORTING_USER` may read. docs/tenancy.md, "Platform analytics".

## 2. Enterprise SSO (SAML 2.0, OIDC per tenant) and SCIM 2.0

Depends on 1a, 5 (IdP secrets), 18 (SCIM actor) and 24 (session method).

- **No account takeover through JIT.**
  - A tenant may assert emails only for domains it has verified (DNS TXT).
  - JIT creates a **membership**. It links an existing global user only if that tenant
    verified the user's email domain.
  - OIDC requires `email_verified`.
  - Identities are keyed by the IdP's immutable subject, with `provider` namespaced per
    tenant. Today's PK `(provider, subject)` (`iam.tables.ts:91`) would collide between
    two tenants' Okta instances.
- **Deprovisioning.** SCIM `active=false` or `DELETE`:
  - removes the membership;
  - revokes that tenant's sessions and tokens;
  - deactivates the user only when no membership remains.
- **SAML.**
  - Use `@node-saml/node-saml` (there is no `@nestjs/*` package).
  - SP-initiated by default. IdP-initiated is opt-in per tenant, because it is a
    login-CSRF vector.
  - `InResponseTo` is required for SP-initiated.
  - Only signed assertions are accepted, and two certificates during a rotation.
  - Store assertion IDs until they expire (replay), and allow for clock skew.
- **SSRF.** Fetch metadata and discovery URLs on the queue, through the outgoing
  webhooks' SSRF-safe fetcher, with size and time limits.
- **"SSO required"** revokes existing non-SSO sessions. This needs the session's auth
  method (24).
  - Decide whether passkeys count as local.
  - Break-glass: a platform owner with password + TOTP, exempt from the tenant policy;
    every use alerts.
- **SCIM tokens** are API keys of a per-tenant API client with a `scim` permission
  (hashed, rotatable, metered). They are exempt from the bot guard and the `email|ip`
  throttle.
- **SCIM-managed role grants** are read-only in the app, or the next sync undoes manual
  grants.
- **Kept from v1:** PATCH semantics, pagination, idempotent provisioning, and an audit
  entry per change.

## 3. Passkeys (WebAuthn)

Depends on decision 1 (RP ID never changes) and 24.

- Use `@simplewebauthn/server`. `@nestjs/authentication` 0.1.1 has no WebAuthn
  (checked); re-check at build time.
- A passkey satisfies two-factor only with `userVerification: 'required'` and the
  `uv` flag set.
- The "last sign-in method" check (`account.service.ts` `unlinkIdentity`) counts
  passkeys in both directions: removing a passkey, and removing the password or an
  identity.
- **Challenges:**
  - one-time (`GETDEL`), with a short TTL;
  - bound to the user or session and the origin.
- Usernameless sign-in degrades the `email|ip` throttle to IP. Give the ceremonies their
  own limit.
- Native apps need `assetlinks.json` and `apple-app-site-association`. These are JSON,
  so they fit the "REST only" rule; Caddy or the API serves them.
- **Kept from v1:** counter regression with synced counter 0, no attestation, a
  new-device alert, several named credentials.

## 4. Bot protection

- Turnstile by default, behind a pluggable verifier and a guard on declared routes.
- The token travels in a declared `X-Captcha-Token` header (in OpenAPI), so DTOs and the
  generated client stay clean.
- "After N failures" counts per IP or per `email|ip`, identically whether or not the
  account exists. Otherwise the challenge leaks existence.
- **Fail-open is not "unprotected":**
  - a stricter throttle tier;
  - a metric and an alert;
  - a short Redis set of used token hashes for replay.
- Use a 2 s timeout and a circuit breaker from `@nestjs/resilience`, which is already
  installed.
- Native sign-in (`POST /auth/token`) shares the browser sign-in's failure counters and
  challenge (the widget in a web view once asked), until app attestation exists.
- A unit test proves the production config resolves the real verifier, not the stub.

## 5. Personal-data protection: encryption and retention

Depends on 19.

- **One core `EncryptionService`.**
  - It keeps today's `v1.<keyId>.<iv>.<ct>.<tag>` format. The MFA, webhooks and
    idempotency ciphers live inside `@nestjs/authentication`, `@nestjs/webhooks` and
    `@nestjs/idempotency` (four key sets exist today, counting `STORAGE_SIGNING_KEYS`).
    Sharing one cipher needs those packages to accept a pluggable one; check their
    options first, otherwise the service covers template-owned columns only.
  - 2, 11 and 15 use it.
- **The data key never lives in the database.** `MFA_ENCRYPTION_KEYS` is
  auto-created in `app_secrets` when unset (`iam.module.ts`, `loadOrCreateSecret`); a
  key next to its ciphertext protects nothing in a backup.
  - The data key comes from the environment, secrets or a KMS only.
  - Boot is refused without it when encrypted columns exist.
  - Migrating the MFA key out of `app_secrets` is part of this item.
- **AAD:** see decision 3. A Drizzle `customType` alone can't bind to the row, so
  encryption runs in the service layer, or the AAD is limited to table, column and
  tenant.
- **The column declaration is the registry.** Revisions, audit `changes`, export, the
  AI module (15) and log redaction (23) consult it to redact or re-encrypt.
  - Custom-field JSONB needs its own "sensitive" flag.
  - Encrypted columns are excluded from the generated `tsvector`.
- **Blind index:**
  - a separate HMAC key;
  - values normalized first (E.164, trimmed, lower-cased);
  - a second index column while the HMAC key rotates.
- **Re-encryption job:**
  - chunked and resumable;
  - `UPDATE … WHERE key_id = old`, so it tolerates concurrent writes;
  - a `rows_on_old_key` metric. The old key leaves only at zero.
- **Retention is built on the existing `PersonalDataRegistry`**, not a second engine.
  - It reaches revisions, audit `changes`, export and report files already in S3 (a
    short TTL on those objects), and backups (a documented retention).
  - Legal holds are one table, checked by both the retention job and the nightly
    `AccountDeletionJob` (which doesn't check holds today).

## 6 + 8. Feature generator and unified event declaration

**6 is done (2026-10-17, #24 and #25, then the capabilities and the skill):**
`pnpm feature:add` (`tools/feature`) writes a feature's standard parts from
`--fields` and `--with`, appending to `features/index.ts` (each feature
declares itself in `<x>.feature.ts`); the `/add-feature` skill
(`.claude/skills/`) interviews and runs it. Owner's decisions: CI's
`feature-smoke` job generates two features with every option and runs their
generated tests, instead of regenerating notes and diffing it (notes keeps
business logic the generator must not emit); generated texts are English in
every locale, listed to translate. Since then (2026-10-17): custom fields (#38),
events (webhooks for a record's changes) and numbered records (#41), `softDelete` and
`team` declared once and changeable later (#40), `clientAccess`, `grants` and
per-feature `idempotency` (#48), and approvals and settings (#230): `--approvals`
and `--settings`, or `approvals` and `settings` in the declaration, with the
effects file `feature:sync` keeps. Still open: 8 (one event declaration).

Planned as:

- **Generator:**
  - a small generator in `tools/`. A Nest schematic is not used, because it pulls in
    the Angular devkit.
  - It emits the feature skeleton, including `tenant_id` and the composite
    `(tenant_id, id)` key.
  - It appends to a `features/index.ts` barrel instead of editing `app.module.ts`.
  - It refuses to run when the feature exists.
  - Record-level routes are already declared, not written (`RecordRouteSpec`,
    `platform/records`): the generator emits the spec and the module's list of
    `<module>Routes()` calls, no controllers for them.
- **Not done (owner's decision, above):** `notes` as the golden output that CI
  regenerates and diffs. `feature-smoke` generates two features instead, and
  `template-without-notes` proves the core stands with the example removed.
- **One event declaration.** Notifications, webhooks and realtime each declare event
  types today; they become one domain-event declaration with channels, and the
  generator emits one. **Done (#320):** `defineDomainEvents()` (`platform/events/domain-event.ts`) declares an event once with its webhook, notification and realtime channels; notes uses it, and a record's capabilities derive theirs through it, so the generator's feature file stays `record:` alone.
- **The realtime manifest** (done, #229): `platform/realtime/realtime-events.ts` goes into
  the OpenAPI document as `x-realtime-events`, so `client:check` diffs it and oasdiff
  (21) catches breaking changes; the client's `src/realtime-events.ts` is generated.
- Events are emitted only through the typed map. Payloads are validated at runtime in
  dev and test only.

## 7. Frontend starter (`apps/web`)

After 8; it grows with each auth item. **Mostly built** ([monorepo](monorepo.md), "The
web app"): Vite, TanStack Router (file routes, not React Router) and Query, nuqs,
react-i18next with the five locales, shadcn/ui on Base UI and Dice UI, the `sidebar-07`
shell, Caddy serving it with a CSP (#64, #80); sign-in with every method, the session
guard, step-up and the account pages (#78); the generic list page (#70, #81);
per-feature texts and grouped navigation (#98); notifications (#101); the notes' record
pages and panels (#100, #112, #137); settings (#105, #135); access administration
(#108); API clients and usage (#109); approvals (#121); search and the audit log
(#125); exports, imports, reports and bulk work (#131); the web app in the devcontainer
(#147); removing the web's notes with the feature (#149); webhooks (#89), custom
fields (#94), tenants for operators (#95) and privacy (#96). Open: PDF documents
(#93), the panels on the API's capabilities (#141).

- Decision 2 above sets the framework (Vite SPA recommended).
- Decision 1 settles cookies. With the single-origin recommendation, the SPA is
  same-origin behind Caddy.
- i18n keys are shared through a `packages/i18n` package (the five catalogs live in the
  API today).
- `apps/web` stays out of the API image build context. Playwright has its own CI job (`e2e-web`, #97).
- **Kept from v1:**
  - sign-in with all methods;
  - profile, language and time zone (RTL);
  - the notification bell;
  - the approvals inbox;
  - the generic list page;
  - problem-details errors;
  - refetch after a realtime reconnect;
  - accessibility.

## 9. Release automation

After 10's commit hooks.

- **The release that matters is adopters pulling template updates.** Document the
  upstream-remote merge (`git remote add template …`).
- Use changesets for `packages/api-client`, which has its own consumers.
- A PR-title check keeps squash merges conventional. The repository squashes
  single-commit PRs under the commit subject (`COMMIT_OR_PR_TITLE`); switch it to
  `PR_TITLE` (an owner action) or check commit subjects too.
- **Rollback means rolling the image back.** That works only under the expand/contract
  policy (20). The release notes' migrations section is generated from
  `apps/api/drizzle/`.

## 10. Developer conveniences

- **Demo seed:**
  - runs through services via `createApplicationContext`, as the system principal
    (18);
  - generates passwords and prints them once (seeded fixed passwords trip the breach
    check);
  - refuses production through a **positive** check: `NODE_ENV` plus a
    database marker. app10 runs the same image.
- **lefthook:** Prettier (not on `docs/`, which reflows tables) and oxlint on staged
  files, plus a commit-message check. There is no `db:check` or `client:check` in the
  hooks; CI owns those.
- **Devcontainer:** `test/global-setup.ts` starts its own PostgreSQL and Redis, so it
  needs an env override to reuse the devcontainer's services.

## 11. Push and SMS

**Done (#236), with the exceptions in the Status row.** Needs 5 (phone numbers are PII, with a blind index for OTP lookup).

- A **`devices` table** (user, platform, push token, last seen) with its own lifecycle,
  revoked with the token rather than at session end (web sessions end at 12 h).
- **SMS toll fraud:**
  - per-account and per-IP limits;
  - a country allowlist;
  - a daily spend cap with a kill switch (feature flag) and an alert.
- Urgent messages (OTP, new-device alert) bypass quiet hours.
- STOP arrives through incoming webhooks and becomes "opted out; START only re-enables",
  with suppression at the provider as well.
- **Kept from v1:** queue with retries, per-channel preferences, OTP verification,
  length and payload limits.

## 12. Saved views

- Views are validated on apply as well as on save.
- Columns the viewer may not see are hidden, not an error.
- When the owner is deprovisioned (2), views are transferred or disabled. Views are
  registered as a `PersonalDataSource`.
- **Kept from v1:** permissions apply per viewer; missing fields; views in exports and
  scheduled reports.

## 13. PDF generation

- A **pinned Gotenberg container**, not Chromium in the worker image. An OOM there would
  stop every queue and workflow, and the CVE surface would sit next to the database
  credentials.
  - The worker reaches it on an `internal: true` Compose network with no egress, plus
    Gotenberg's Chromium URL deny or allow lists (verify the flags).
  - The image carries fonts for Arabic and CJK.
- An autoescaping template engine, with no remote resources (SSRF through `<img>`).
- The attachment is created and linked to its record in the transaction that completes
  the job; otherwise the orphan sweep deletes it.
- Issued documents are immutable; regenerating creates a new attachment.
- Tests fix the PDF metadata dates and compare text or rasterized pages, not bytes.

## 14. Money and currency

- **Amounts:**
  - stored as `bigint` minor units plus an ISO 4217 code;
  - unit prices and rates as `numeric`;
  - all of them travel as strings end to end, typed in OpenAPI as `string`.
- **Rounding:** a parameter, defaulting to half-up (invoicing and VAT). Banker's
  rounding only where a domain asks for it.
- **Allocation** splits an amount without losing a cent (largest remainder).
- `Intl.NumberFormat` with an explicit numbering system, because `ar` gives
  Arabic-Indic digits otherwise.
- **Rates:**
  - ECB daily, EUR base, with triangulation and defined rounding;
  - the rate's date and source stored on every converted amount.

## 15. AI helper

**Done: see the table above and [ai.md](ai.md).** The plan it followed:

After 1a and 5.

- Check for a `@nestjs/*` AI package and the Vercel AI SDK before writing the
  interface. Use the Claude API reference at build time.
- **Model and prompt versions:**
  - pin the exact model id;
  - store the model id and the prompt-template version on every usage record;
  - cache keys include both, plus the tenant.
- Structured output through tool use with a schema, validated by Zod: this is the real
  prompt-injection mitigation.
- BullMQ `lockDuration` exceeds the longest generation (or the lock is extended).
  Otherwise the job is retried while still running, and the work is paid for twice.
- Redaction uses 5's column registry.
- **Kept from v1:** per-tenant opt-in, quotas through usage, a stub provider, timeouts
  and retries, streaming over realtime.

## 16. Alerts

- **16a (phase A).**
  - An always-firing `Watchdog` alert routed to an external dead-man receiver
    (decision 5). None exists today.
  - A certificate-expiry and liveness probe: blackbox-exporter on the Compose network
    probing **`https://caddy:443`** with `tls_config.server_name` set to the public
    host.
  - `BackupTooOld` already exists (`monitoring/prometheus/alerts.yml:265`).
- **16b (done, #256).** node-exporter in `compose.monitoring.yaml` (job `node`, six
  `host` alerts with promtool tests) and the outside probe
  (`.github/workflows/uptime-probe.yml`, off until the `UPTIME_PROBE_URL` variable
  is set). docs/deployment.md, "Alerting". What was planned:
  - node-exporter in Docker Desktop sees the Linux VM. That is still useful, because
    `Docker.raw` is what fills.
  - The Mac itself needs a Homebrew `node_exporter` scraped through
    `host.docker.internal`.
  - An outside-world probe applies only to deployments with public DNS (not app10).

## 17. Load tests

- **17-lite (phase B):**
  - sign-in, list with filters, and create;
  - nightly on a GitHub runner, with a JSON baseline artifact (built as manual-only for now, to save Actions minutes);
  - fails only on 2× regressions.
- **17-full (done, #255):**
  - an export scenario in k6 (the request, then the time to a ready file);
  - realtime through Artillery's socket.io engine (`loadtest/realtime.yml`, pinned image), because k6 doesn't speak socket.io;
  - several replicas (`LOADTEST_REPLICAS`);
  - the bot check's cost: the stub verifier, allowed under `NODE_ENV=production` only with `APP_ENV=loadtest` (`LOADTEST_CAPTCHA=always`);
  - still open: the delivery latency of a pushed realtime event; manual runs only, not in CI.
- A dedicated load-test API client with a high quota and env-raised throttling, rather
  than disabled limits. The bot guard is stubbed for this run only.
- A self-hosted runner (the Mac) only behind `workflow_dispatch`.

## New items from the review's gaps

### 18. System principal

- One `system` principal for work that runs without a user: seeds, cron jobs, the
  outbox relay, SCIM, AI calls and the demo seed.
- Its permissions are declared like any other principal's.
- Audit entries name it, together with the job that ran.
- #29's `user.seeded` entry moves to it.

### 19. Secrets management

- Docker secrets on single-host Compose, behind one `SecretsService` (file, then env,
  then a KMS later).
- A documented rotation per secret: SAML keys, the data key, FCM, APNs, provider
  tokens.

### 20. Expand/contract migration policy

- A rule in `docs/pitfalls.md`: never drop, rename or retype a column in the release
  that stops using it.
- A CI lint that flags destructive DDL in newly generated migrations.
- It reports only until the first project is built on the template, then it blocks.

### 21. OpenAPI breaking-change detection

- `oasdiff` in CI against `main`'s spec. It fails on removed fields, endpoints and
  (after 8) realtime events.
- `client:check` only detects drift.

### 22. Email deliverability

- Bounces and complaints arrive from the provider (Amazon SES through SNS, behind
  a `MailEventIntake` interface; other providers are adapters of their own) and
  feed a suppression list, which the mail sender respects.
- SPF, DKIM and DMARC are documented ([deliverability.md](deliverability.md)).

### 23. Log redaction

- Request logs and error reports redact the registry's encrypted and sensitive columns
  (5) and known secret headers.

### 24. Session auth method and step-up

- The session records how it was created: password, magic link, OIDC, SSO or passkey.
- Sensitive actions require a recent re-authentication: changing email, disabling 2FA,
  creating API keys, SSO settings.
- Needed by 2 (revoking non-SSO sessions) and 3.

### 25. Groups: teams, departments, organizations inside a tenant

**Decided (owner, 2026-10-17): teams, a rename only.** Org units became
**teams** (the Better Auth word): tables `teams`, `team_tree`, `user_teams`,
`/v1/access/teams`, `teamIds`/`teamId`, `manageTeams`, `inMyTeams`, the
`team` settings scope, the `teamRole` approval rule; nesting stays (an
optional parent). Names stored in rows are rewritten at migrate
(`stored-renames.ts`). The group redesign below is **not planned for the
template**: a project that needs group types, membership roles or an owner
group per record builds it on teams. Kept for reference:

Decision 6. This **replaces** today's org units outright (breaking changes are
accepted, see the top).

What exists today:
- one tree;
- users in several units;
- records with an `orgUnitId`;
- `inMyUnits`, which grants a unit and everything below.

What changes:
- the tables, the `/v1/access/org-units` routes, `inMyUnits` and the approvals rules
  that use units are renamed and reshaped to groups;
- `notes` and the generator move to `owner_group_id`;
- the client is regenerated.

- **Group types per tenant.** Each tenant declares its own types (division,
  department, team, project, region…) and which may nest under which. There is no
  fixed list in code.
- **Several structures.** The hierarchy (company → division → department) plus
  cross-cutting groups (project teams, committees, regions) a user can join alongside.
  - A group belongs to one tree; there are several trees per tenant.
  - Each tree has its own closure table rows.
- **A role per membership.** Member, lead or manager in *this* group. "Lead of Sales"
  then sees Sales and everything below, and a member sees only their own group.
  Today's membership carries no role.
- **Records are owned by a group** (`owner_group_id`), with optional extra groups they
  are shared with. The generator (6) emits the column.
- **Conditions:**
  - `inMyGroups` (exact);
  - `inMyGroupsAndBelow`;
  - `inGroupsILead`;
  - `inGroupsOfType('department')`.

  They are evaluated through the closure table, so they work at any depth.
- **Reports, exports, scheduled reports and saved views (12) run as the viewer.** The
  same query gives the CEO, at the root, the whole company and a team lead their team.
  Group subtotals come from a `group by` over the closure table.
- **Moving and merging.** Moving a group moves its records' visibility, as today.
  Merging two groups re-owns their records in a background job.
- **SCIM groups (2)** map to groups and membership roles.
- **Kept in permissions, not RLS.** Memberships overlap and change often. RLS stays the
  tenant wall, and CASL handles groups.

---

## Where v2 departs from the review

- **Item 0 is done.** The review predates #29. #29 already writes an audit entry (the
  review said none), and its advisory lock makes seeding safe in every role, so
  restricting it to api/migrate isn't needed. The breach check already has an
  `HttpClient` timeout and fails open.
- **Approvals is done**, so the review's "finish approvals before 1" is satisfied.
- **16's probe target is corrected.** `https://127.0.0.1` inside the blackbox
  container is the container itself; probe Caddy by its Compose service name.
- **17's runner risk is smaller.** The repo is private, so "public PRs run code on the
  Mac" doesn't apply today. Keep `workflow_dispatch` anyway, since adopters may fork it
  publicly.
- **1a, added:**
  - role and grant bootstrap is outside drizzle-kit (open);
  - the cost of holding a pooled connection for a whole request;
  - app10's one-time role setup.
- **5, added:**
  - the DB-generated UUIDv7 makes row-bound AAD need app-side ids;
  - moving the existing MFA key out of `app_secrets`;
  - a sensitive flag for custom-field JSONB.
- **Gaps** got item numbers (18–24) and places in the order.
- **Groups (25) and the tenant tree (1b)** come from the owner's requirement that
  companies organize and report across their own teams. The review assumed a flat
  tenant.
