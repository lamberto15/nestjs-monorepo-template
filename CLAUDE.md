# CLAUDE.md

A **NestJS 12 REST backend template**: the starting point for new projects.
A pnpm + Turborepo monorepo: the API in `apps/api`, the typed client in
`packages/api-client`, frontends next to them. Commands run from the root.
Details live in `docs/`: read the file a task needs, not all of them.

## Owner's rules (always apply)

- **Never edit `main`: every change goes through a worktree.** Each change
  gets a branch in its own worktree (`.claude/worktrees/<name>`), a pull
  request to `origin` (GitHub) and green CI; then the worktree is removed and
  the PR squash-merged with its branch deleted. Never rebase or force-push:
  update a branch with `git merge origin/main`. See docs/development.md, "Git workflow".
- **Check the NestJS docs before building anything.** Look up the NestJS docs
  (Context7, docs.nestjs.com, or the markdown in github.com/nestjs/docs.nestjs.com)
  and the installed `@nestjs/*` packages first, so nothing NestJS offers gets
  rebuilt by hand. Write custom code only when nothing fits, and say why in a comment.
- **Library questions:** fetch current docs with Context7 (`resolve-library-id`,
  then `query-docs`) before answering or coding.
- **REST only, no HTML.** The only page is Swagger UI at `/api`.
- **Never hand-write migrations or DDL.** Change a `*.tables.ts`, run
  `pnpm db:generate`, commit `apps/api/drizzle/`.
- **Generic naming:** `user` (people), `client` (systems); "staff" and the
  like are roles.
- **Keep the grouping:** core ← iam ← platform ← features; groups never import features.
- **Separation of concerns:** controllers do HTTP only; services own the
  logic and the queries (one transaction with the audit entry); repositories
  only for data many services share. See docs/architecture.md, "Code style".
- **Heavy or slow work goes to a queue worker**, never in the request.
- **Every feature follows docs/adding-a-feature.md** (tables with `uuidPk()`
  and `timestamps()`, the list declaration, routes, audit, tests), so the API
  stays uniform.
- **Newest versions, pinned** (never `:latest`); Dependabot proposes updates.
- `.env*` files can't be written by Claude: the owner copies the template
  (`cp env.example .env` at the root and fills it, or `cp
  apps/api/env.development.example apps/api/.env.development`). Keep
  `env.example` complete when adding variables.

## Map

| Need | Read |
| --- | --- |
| Where things are, the processes, how features plug in | [docs/architecture.md](docs/architecture.md) |
| The monorepo: root scripts, Turborepo, adding a frontend app | [docs/monorepo.md](docs/monorepo.md) |
| Setup, commands, tests, migrations, the git workflow, git hooks and commit-message checks | [docs/development.md](docs/development.md) |
| A new feature | [docs/adding-a-feature.md](docs/adding-a-feature.md) |
| Load tests: k6 on the production stack, the baseline (manual runs), a 2× regression, accepting a change (`loadtest/run.sh`) | [docs/development.md](docs/development.md), "Load tests" |
| Routes' rules: versions, errors, pagination, filters, credentials | [docs/api-conventions.md](docs/api-conventions.md) |
| The typed client for frontends (`packages/api-client`, `pnpm client:generate` after route changes) | [docs/development.md](docs/development.md), "Typed client" |
| Sign-in, accounts, tokens, API clients, impersonation, bot protection (Turnstile); data export, account deletion, consents | [docs/auth.md](docs/auth.md) |
| Roles, conditions, field-level, grants, org units, audit | [docs/permissions.md](docs/permissions.md) |
| Queues, mail, outbox, workflows, cron, realtime | [docs/background-work.md](docs/background-work.md) |
| Exports and imports | [docs/data-transfer.md](docs/data-transfer.md) |
| Bulk operations (delete, restore, change many records; 202 jobs) | [docs/bulk-operations.md](docs/bulk-operations.md) |
| Custom fields (runtime fields, JSONB values) | [docs/custom-fields.md](docs/custom-fields.md) |
| Notifications (in-app, realtime, mail, webhook; preferences, digests) | [docs/notifications.md](docs/notifications.md) |
| Settings and feature flags (runtime values, scopes, rollouts) | [docs/settings.md](docs/settings.md) |
| Human-readable numbers (gapless sequences) | [docs/sequences.md](docs/sequences.md) |
| Money: minor-unit amounts, rounding, allocation, formatting; ECB exchange rates and conversion | [docs/money.md](docs/money.md) |
| Comments and @mentions on records | [docs/comments.md](docs/comments.md) |
| Files attached to records (uploads, downloads, the orphan sweep) | [docs/attachments.md](docs/attachments.md) |
| Tags (labels) on records: managing them, filtering lists by them | [docs/tags.md](docs/tags.md) |
| Scheduled reports (an export run on a schedule, mailed with a link) | [docs/reports.md](docs/reports.md) |
| Email deliverability (SPF, DKIM, DMARC for SES; bounces and complaints through SNS; the suppression list the sender respects) | [docs/deliverability.md](docs/deliverability.md) |
| Record revisions: history, diff between two, restore one (retention) | [docs/revisions.md](docs/revisions.md) |
| Approvals: declared policies, stages, approver rules, delegation, escalation, extending | [docs/approvals.md](docs/approvals.md) |
| API clients' usage per day and route, daily quotas (429 `quota_exceeded`) | [docs/usage.md](docs/usage.md) |
| Languages, time zones | [docs/i18n-and-time.md](docs/i18n-and-time.md) |
| Environment variables | [docs/configuration.md](docs/configuration.md) |
| Compose, staging, scaling, CI and its scans, published images (GHCR, `APP_IMAGE`, rollback) | [docs/deployment.md](docs/deployment.md) |
| Prometheus metrics (`GET /metrics`, METRICS_TOKEN; platform gauges via `MetricsService.collect()`) | [docs/deployment.md](docs/deployment.md), "Metrics" |
| Alerts (`monitoring/`: rules, their promtool tests; optional `compose.monitoring.yaml` with Prometheus + Alertmanager) | [docs/deployment.md](docs/deployment.md), "Alerting" |
| Mistakes already made | [docs/pitfalls.md](docs/pitfalls.md) |
| What gets built next, in order (items 0–24, open decisions, status) | [docs/roadmap.md](docs/roadmap.md) |

## The check before every commit

```bash
pnpm build && pnpm lint && pnpm test && pnpm test:e2e   # e2e starts redis-server and PostgreSQL (Docker)
pnpm db:check                                           # after table changes
pnpm client:check                                       # after route changes (pnpm client:generate fixes it)
```

Current state: CI on `main` is green (unit and e2e tests, lint, the image, the
scans). Edge cases live in `apps/api/test/edge-*.e2e-spec.ts`, security
regressions in `apps/api/test/security.e2e-spec.ts`. Test counts are not kept
here: every pull request changed them, so every pair of open pull requests
conflicted on this line.

## The pitfalls that bite most

- Services read the database through the transaction host (`database(this.txHost)`)
  and write with `inTransaction()`: every query joins the current transaction.
- Module order in `app.module.ts`: Platform, then Core, then Iam.
- Abstract base classes of injectables need `@Injectable()`; inject
  `ConfigService<Env, true>` with a value import.
- Python/sed edits must fail loudly when a match misses (Prettier reformats code).
- Shell: `grep` is ripgrep, `ls` is eza; hooks refuse `/dev/null` redirects
  and recursive deletes of system paths, even in heredocs.

## Deployed instance

The owner's instance ("app10") runs the Compose production stack on the owner's Mac
(redeployed 2026-10-15: api ×2, worker, PostgreSQL 18, Redis 8, Caddy with
a Let's Encrypt certificate). Its `.env` keeps `COMPOSE_PROJECT_NAME=nestjs-template`,
the template's first name (then `nestjs-backend-template`, now
`nestjs-monorepo-template`): the volumes carry it. The name
has no public DNS record: `/etc/hosts` points it at 127.0.0.1. Redeploy with
`docker compose up -d --build --remove-orphans` (`.env` sets the files).
The old build's `nestjs-template_app_data` volume is unused; removing it is
the owner's decision.
