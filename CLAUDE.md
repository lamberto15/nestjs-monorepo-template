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
- **New features start from `pnpm feature:add`** (the `/add-feature` skill in
  `.claude/skills/` asks what to add and runs it); never copy `notes` by hand.
  Then write only the business logic, where the generated service says so.
- **Newest versions, pinned** (never `:latest`); Dependabot proposes updates.
- **Models for Claude: never Fable.** Subagents and delegated tasks use the
  cheapest model that does the job well: Haiku 5.5 for simple searches and
  mechanical edits, Sonnet 5.5 for ordinary coding and exploration, Opus 5.5
  only for complex or security work (and the main session). Set `model` on
  every Agent call.
- `.env*` files can't be written by Claude: the owner copies the template
  (`pnpm setup` writes them, or `cp env.example .env` at the root and fills it, or `cp
  apps/api/env.development.example apps/api/.env.development`). Keep
  `env.example` complete when adding variables.

## Map

| Need | Read |
| --- | --- |
| Where things are, the processes, how features plug in | [docs/architecture.md](docs/architecture.md) |
| The monorepo: root scripts, Turborepo, adding a frontend app | [docs/monorepo.md](docs/monorepo.md) |
| Setup (`pnpm setup`, the first-run wizard), commands, tests, migrations, the demo seed (`pnpm db:seed:demo`), the devcontainer, the git workflow, git hooks and commit-message checks | [docs/development.md](docs/development.md) |
| A new feature: `pnpm feature:add` (`tools/feature`, the `/add-feature` skill); changing one: edit its `<item>.record.ts` (fields, capabilities), then `pnpm feature:sync` (`platform/fields`, `platform/records`) | [docs/adding-a-feature.md](docs/adding-a-feature.md), "Changing a feature" |
| Load tests: k6 on the production stack, the baseline (manual runs), a 2× regression, accepting a change (`loadtest/run.sh`) | [docs/development.md](docs/development.md), "Load tests" |
| Outgoing and incoming webhooks, the ops API, realtime (socket.io), health | [docs/webhooks-and-realtime.md](docs/webhooks-and-realtime.md) |
| Routes' rules: versions, errors, pagination, filters, credentials | [docs/api-conventions.md](docs/api-conventions.md) |
| The typed client for frontends (`packages/api-client`, `pnpm client:generate` after route changes) | [docs/development.md](docs/development.md), "Typed client" |
| Tenants: the RLS wall, the tenant of the work (requests, jobs, workflows, cron), global tables, operators, single-tenant deployments (`TENANCY=single`), adding a tenant table | [docs/tenancy.md](docs/tenancy.md) |
| Sign-in, accounts, tokens, passkeys (WebAuthn), API clients, impersonation, bot protection (Turnstile); data export, account deletion, consents | [docs/auth.md](docs/auth.md) |
| Roles, conditions, field-level, grants, teams, audit | [docs/permissions.md](docs/permissions.md) |
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
| PDF documents of records (templates, RTL, Gotenberg, the queue job, issued attachments) | [docs/documents.md](docs/documents.md) |
| Tags (labels) on records: managing them, filtering lists by them | [docs/tags.md](docs/tags.md) |
| Scheduled reports (an export run on a schedule, mailed with a link) | [docs/reports.md](docs/reports.md) |
| Email deliverability (SPF, DKIM, DMARC for SES; bounces and complaints through SNS; the suppression list the sender respects) | [docs/deliverability.md](docs/deliverability.md) |
| Record revisions: history, diff between two, restore one (retention) | [docs/revisions.md](docs/revisions.md) |
| Approvals: declared policies, stages, approver rules, delegation, escalation, extending | [docs/approvals.md](docs/approvals.md) |
| API clients' usage per day and route, daily quotas (429 `quota_exceeded`) | [docs/usage.md](docs/usage.md) |
| Languages, time zones | [docs/i18n-and-time.md](docs/i18n-and-time.md) |
| Environment variables | [docs/configuration.md](docs/configuration.md) |
| Compose, staging, scaling, CI and its scans, published images (GHCR, `APP_IMAGE`, rollback) | [docs/deployment.md](docs/deployment.md) |
| Zero-downtime deploys: `pnpm deploy:rolling`, `deploy:blue-green`, `deploy:swarm` | [docs/deployment.md](docs/deployment.md), "Zero-downtime deploys: three ways"; [rolling](docs/deploy-rolling.md), [blue-green](docs/deploy-blue-green.md), [Swarm](docs/deploy-swarm.md) |
| Zero-downtime deploys: which of the three, and what each needs | [docs/deployment.md](docs/deployment.md), "Zero-downtime deploys" |
| Rolling deploys with Compose (`pnpm deploy:rolling`), graceful shutdown | [docs/deploy-rolling.md](docs/deploy-rolling.md) |
| Blue-green deploys: two api colours, switching the traffic, instant rollback (`pnpm deploy:blue-green`, `compose.blue-green.yaml`) | [docs/deploy-blue-green.md](docs/deploy-blue-green.md) |
| Docker Swarm: the stack, rolling updates, automatic rollback, nodes and secrets (`pnpm deploy:swarm`, `compose.swarm.yaml`) | [docs/deploy-swarm.md](docs/deploy-swarm.md) |
| Template releases (`v*` tags, generated notes, migrations section), the typed client's changesets (`pnpm changeset`, the version PR, npm publishing off) | [docs/releases.md](docs/releases.md) |
| Projects built on the template pulling its updates (upstream remote, merging a tag, conflicts, the migrations caveat) | [docs/upgrading.md](docs/upgrading.md) |
| Log redaction (secret headers and fields, text patterns; `logRedaction.declare*()` at import time, the registry item 5 extends) | [docs/deployment.md](docs/deployment.md), "Log redaction" |
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
from **this checkout's main** (redeployed 2026-10-17 after tenancy, #14: api ×2,
worker, Gotenberg, backup, PostgreSQL 18, Redis 8, Caddy with a Let's Encrypt
certificate). Its `.env` sets `COMPOSE_PROJECT_NAME=nestjs-monorepo-template`, so
its volumes are `nestjs-monorepo-template_*`; they were made fresh for the tenancy
reset. The name has no public DNS record: `/etc/hosts` points it at 127.0.0.1.
Redeploy with `docker compose up -d --build --remove-orphans` from this checkout
(`.env` sets the files; `compose.monitoring.yaml` isn't among them).

- **Check which checkout a running stack came from** before redeploying:
  `docker inspect <container> --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'`.
- **Unused, removing them is the owner's decision:** the old checkout
  `../nestjs-backend-template` (the private archive) and its
  `nestjs-template_*` volumes, which held app10 before the reset.
- **Deleting a production volume** is the owner's to run; the permission
  check refuses it to Claude.
