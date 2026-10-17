# Architecture

A NestJS 12 REST backend (JSON only; Swagger UI at `/api` is the only page)
in a pnpm workspace run by Turborepo, so frontends can live next to it.

## The repository

```
apps/
  api/                 the NestJS app (@nestjs-monorepo-template/api)
    src/               the code (below)
    test/              e2e tests (*.e2e-spec.ts)
    drizzle/           generated migrations (pnpm db:generate)
    Dockerfile         the production image, built from the repository root
    package.json       the app's dependencies and scripts
    nest-cli.json, tsconfig*.json, vitest.config*.ts, drizzle.config.ts
    env.development.example   → .env.development (development settings)
  <your frontend>/     added by you: docs/monorepo.md
packages/
  api-client/          the typed client (@nestjs-monorepo-template/api-client)
caddy/  dev/           the HTTPS proxy's image; the development services' files
gotenberg/             the PDF renderer's image (Gotenberg, thin on the official one)
compose*.yaml          Docker Compose: shared, development, production, blue-green, Swarm, monitoring, load test
env.example            → .env, Compose's production settings
package.json           the root scripts (pnpm build, pnpm test…), tooling only
pnpm-workspace.yaml    the workspace: apps/*, packages/*
turbo.json             the tasks (build, lint, test, test:e2e) and their cache
tools/                 scripts: setup (first-run wizard), feature (generator), deploy (rolling, blue-green, Swarm), migration lint, release notes
.changeset/            the typed client's pending changes (pnpm changeset)
```

Commands run from the root: its scripts hand each one to the package it
concerns (`turbo run …`, or `pnpm --filter @nestjs-monorepo-template/api …`).
More in [monorepo](monorepo.md).

## The app

The code (`apps/api/src/`) is in three groups and your features:

```
src/
  main.ts          boots the API (APP_ROLE api | worker | all)
  worker.ts        the same app as a worker (APP_ROLE=worker)
  migrate.ts       applies every migration once per deploy
  seed-demo.ts     the demo seed (pnpm db:seed:demo), development databases only
  configure-app.ts what main.ts and the tests apply (HTTP setup, realtime, OpenAPI)
  app.module.ts    the composition root: groups, then features
  env.ts           every group's environment schema, validated at startup
  schema.ts        every table, for Drizzle and drizzle-kit
  i18n/            translation catalogs, one folder per language
  mail/templates/  email templates (HTML, one per language)
  documents/templates/  PDF document templates (HTML; layout.html wraps them)

  core/       what everything stands on
  iam/        identity and access
  platform/   services features call
  features/   your code (notes/ is the example; pnpm feature:remove notes drops it)
  demo/       the demo seed's data and seeder (it knows the features, like app.module.ts)
```

| Group | Holds |
| --- | --- |
| `core/` | config (Zod), database (Drizzle on PostgreSQL 18), tenancy (the tenant scope, row-level security, the pool that sets it: [tenancy](tenancy.md)), Redis, HTTP (security headers, CORS, CSRF, versioning, validation, rate limits, problem details, pagination, filters), logging and NestJS Observe, health (terminus), Prometheus metrics (`/metrics`), i18n, mail and its queue, BullMQ, locks and cron, the tree helper |
| `iam/` | sessions, tokens, API clients and keys, accounts (passwords, two-factor, OAuth, magic links, invitations, impersonation), roles and permissions (CASL, field-level, expiring grants), teams, resource declarations, the audit log, the system principal (`SystemContext.run()`: work without a user) |
| `platform/` | idempotency, outbox, webhooks (out and in), workflows, feature queues, storage, http-client and resilience, realtime (socket.io), exports and imports, bulk operations, PDF documents (Gotenberg), custom fields, notifications, record subscriptions, global search, sequences, scheduled reports, record revisions, settings and feature flags, approvals (multi-stage, on durable workflows), money (minor-unit amounts, rounding, allocation, formatting, ECB exchange rates), a person's own account, the ops API, the switches report (`GET /v1/features`) |
| `features/` | one folder and module per feature |

## Rules

- **Dependency direction:** core ← iam ← platform ← features. A group never
  imports a feature; only `features/index.ts`, `features/tables.ts` and
  `features/env.ts` list them all, and `app.module.ts`, `schema.ts`, `env.ts`
  and `openapi.ts` read those lists.
- **Features plug in by declaration**: each feature's `<x>.feature.ts`
  (`defineFeature()`, `features/feature.ts`) names its module, Swagger tag
  and everything below, and `features/index.ts` lists it:
  - permissions: `definePermissions()` → `IamModule.forRoot({ permissions })`;
  - webhook event types and incoming senders → `PlatformModule.forRoot({ eventTypes, incomingWebhooks })`;
  - queues and resilience presets → `PlatformModule.forRoot({ queues, resiliencePresets })`;
  - custom fields (`defineCustomFields()`) → `PlatformModule.forRoot({ customFields })`;
  - notification types (`defineNotifications()`) → `PlatformModule.forRoot({ notifications })`;
  - settings and flags (`defineSettings()`) → `PlatformModule.forRoot({ settings })`;
  - actions that need approval (`defineApproval()`) → `PlatformModule.forRoot({ approvals })`,
    their handlers, approver rules, modes and listeners register into `ApprovalsRegistry`;
  - tables → `features/tables.ts`; environment → `features/env.ts`;
  - exporters and importers register themselves (`DataTransferRegistry`);
  - what goes when a record is purged from its recycle bin: platform
    services register into `RecordPurgeRegistry` (iam), and
    SoftDeletePurgeJob calls them in the purge's transaction;
  - bulk operations register themselves (`BulkRegistry`);
  - record-level routes (tags, comments, attachments, revisions, PDF, watch,
    bulk) are built by the platform from the feature's `RecordRouteSpec`
    (`platform/records/record-routes.ts`, each module's `<module>.routes.ts`):
    the feature module lists `tagRoutes(SPEC)` and the others among its
    controllers, its targets decide who may.
- **Tenancy** ([tenancy](tenancy.md)): every feature table is a tenant
  table behind row-level security; a request, job, workflow step or cron
  run acts in one tenant, and per-principal keys carry it.
- **Module order** in `app.module.ts` matters: `PlatformModule` first (the
  idempotency interceptor must be outermost), then `CoreModule` (the rate
  limit guards before authentication), then `IamModule`.

## Code style: who does what

Object-oriented structure (Nest classes, wired by dependency injection), data
as plain rows, rules in services, and features declared, not coded into the
groups. Each layer has one job:

| Layer | Does | Never |
| --- | --- | --- |
| Controller (`*.controller.ts`) | HTTP: route, Zod body/query, `@Can()`, `@Api*` docs, maps the result to the response | queries the database, opens transactions, holds business rules |
| Service (`*.service.ts`) | the use case: checks, writes in one transaction with its audit entry and outbox events, reads | knows HTTP (requests, cookies, status codes beyond Nest's exceptions) |
| Repository (`*.repository.ts`) | the queries of data that many services share (`UsersRepository`) | business rules |
| Declarations (`*.policy.ts`, `*.list.ts`, `*.resource.ts`, `*.schemas.ts`) | what a feature allows, filters, audits, accepts | run anything |
| Processors, workflows, jobs | background work, calling services | serve HTTP |

- **Services own their queries.** Drizzle is the data layer: typed tables and
  results, SQL kept visible (permission filters, `countPage()`, transactions
  across tables). No repository wrapping each table.
- **A repository only for shared data:** add one when several services read
  or write the same table, so its queries and its safe view (no password hash)
  live once.
- **One change, one transaction:** the write, its audit entry and its events
  together; a failed audit rolls the change back.
- **Rows have no methods.** Entity types come from `typeof table.$inferSelect`.

**When to break from it:** a feature with real invariants (pricing, a stock
ledger, a booking state machine) gets a domain class that enforces them; its
service loads it, calls it and saves it. Say why in a comment.

## Processes

One image, three commands (run in `/app` in the image, `apps/api` in the
repository):

| Command | Role | Does |
| --- | --- | --- |
| `node dist/main` | `APP_ROLE=api` (or `all`) | serves HTTP and WebSockets |
| `node dist/worker` | `APP_ROLE=worker` | queue jobs (mail, exports, imports), the outbox relay, webhook deliveries, workflow steps, cron jobs |
| `node dist/migrate` | one-off | the app's migrations, then the outbox, workflows and webhooks schemas |

`APP_ROLE=all` (the default) runs both in one process: development, tests,
small deployments. Every engine is safe with several instances: shared state
lives in PostgreSQL and Redis, cron jobs take a lock, workers lease their work.
A replica finishes its requests and exits on shutdown, so a deploy can replace
replicas without downtime: rolling or blue-green with Compose, or Docker Swarm
([deployment](deployment.md), "Zero-downtime deploys: three ways").

See also: [development](development.md), [deployment](deployment.md),
[adding a feature](adding-a-feature.md), [webhooks and realtime](webhooks-and-realtime.md).
