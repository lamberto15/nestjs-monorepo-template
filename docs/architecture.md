# Architecture

A NestJS 12 REST backend (JSON only; Swagger UI at `/api` is its only page)
in a pnpm workspace run by Turborepo, with a web app on its typed client next
to it ([monorepo](monorepo.md), "The web app").

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
  web/                 the web app, a React SPA (@nestjs-monorepo-template/web): docs/monorepo.md
    src/routes/        file routes (TanStack Router; routeTree.gen.ts is generated)
    src/features/      one folder per area: its queries, pages' parts, nav.ts, tests
    src/components/, src/lib/   shared parts: the list page, record panels, session, errors, realtime
    src/locales/       texts, one folder per language, one file per namespace
    src/test/          the test helpers (renderApp, the msw server, findToast)
    vite.config.ts, vitest.config.ts, components.json
packages/
  api-client/          the typed client (@nestjs-monorepo-template/api-client)
  ui/                  shared components, shadcn/ui and Dice UI as source (@nestjs-monorepo-template/ui)
caddy/  dev/           the HTTPS proxy's image (it serves the web app too); the development services' files
gotenberg/             the PDF renderer's image (Gotenberg, thin on the official one)
backup/                the backup image: pg_dump and the uploaded files on a schedule
monitoring/            Prometheus rules and their tests, Alertmanager, the blackbox probe
loadtest/              the k6 and realtime load tests (run.sh, scenarios)
compose*.yaml          Docker Compose: shared, development, production, blue-green, Swarm, monitoring, load test
env.example            → .env, Compose's production settings
package.json           the root scripts (pnpm build, pnpm test…), tooling only
pnpm-workspace.yaml    the workspace: apps/*, packages/*
turbo.json             the tasks (build, lint, test, test:e2e, dev) and their cache
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
| `core/` | config (Zod), database (Drizzle on PostgreSQL 18), encryption (`EncryptionService`, encrypted columns and blind indexes: [encryption](encryption.md)), tenancy (the tenant scope, row-level security, the pool that sets it: [tenancy](tenancy.md)), Redis, HTTP (the server, below; security headers, CORS, CSRF, versioning, validation, rate limits, problem details, pagination, filters), logging and NestJS Observe, health (terminus), Prometheus metrics (`/metrics`), i18n, mail and its queue, BullMQ, locks and cron, the tree helper |
| `iam/` | sessions, tokens, API clients and keys, accounts (passwords, two-factor, passkeys, OAuth, magic links, invitations, impersonation), enterprise SSO (SAML, OIDC) and SCIM provisioning (`sso/`), bot protection (`captcha/`), roles and permissions (CASL, field-level, expiring grants), organizational units, tenants (break-glass), legal holds (`holds/`), resource declarations, the audit log, the system principal (`SystemContext.run()`: work without a user) |
| `platform/` | idempotency, outbox, webhooks (out and in), workflows, feature queues, storage, http-client and resilience, realtime (socket.io), exports and imports, bulk operations, PDF documents (Gotenberg), custom fields, tags, comments, attachments, list descriptions (`GET /v1/lists/{subject}`), saved views (`/v1/views`), the people directory and units lookup (`GET /v1/people`, `GET /v1/organizational-units`), notifications, record subscriptions, global search, sequences and naming series, scheduled reports, record revisions, settings and feature flags, API clients' usage and quotas, email deliverability, retention rules (`retention/`), the AI helper (`ai/`), push and SMS channels (`messaging/`), the encrypted columns' re-encryption job (`encryption/`), platform analytics (`analytics/`), domain events (`events/`), approvals (multi-stage, on durable workflows), money (minor-unit amounts, rounding, allocation, formatting, ECB exchange rates), a person's own account, the ops API, the switches report (`GET /v1/features`) |
| `features/` | one folder and module per feature |

### The HTTP server

The API runs on Nest's native `node:http` adapter (`@nestjs/platform-node`,
`createHttpAdapter()` in `core/http/http-setup.ts`, used by `main.ts` and the
tests), not Express: find-my-way routing, its own body parsers, CORS and
multer. Code takes the adapter's `NodeRequest` and `NodeResponse` types (no
`express` import anywhere in `apps/api/src`); they keep the Express helpers
the API uses (`req.ip`, `req.get()`, `res.cookie()`, `res.redirect()`,
`res.set()`). Where it differs from Express, on purpose:

- **Routes match by specificity, not declaration order**: a static segment
  (`/v1/naming-series/subjects`) wins over `:id` wherever either is declared.
- **Paths are case-sensitive**: `/V1/notes` is a 404.
- **A path parameter over 2048 characters is a 414** (`MAX_PARAM_LENGTH`;
  the adapter's default of 100 would refuse the unsubscribe link's token).
- **`req.path` is the decoded path** the router matched. The metrics, the
  usage meter and the logs label a request by its route pattern
  (`route-key.ts`, which also names the OpenTelemetry server span) or by
  `originalUrl`, never by `req.path`.
- **A type set on the response gets no `; charset=utf-8`**: the problem
  filter and the routes that set a JSON type spell it out, so responses
  carry the charset they had.
- **No ETag of its own** on a JSON reply (Express added a weak one to every
  2xx GET): `core/http/etag.ts` gives the records their strong ETags, 304
  and 412, as before.
- **`uploadToDisk()` is handed its disk** (`StorageDisk`): @nestjs/storage
  finds a disk by name through Express's and Fastify's requests only.

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
  - domain events (`defineDomainEvents()`): one declaration for an event's webhook,
    notification and realtime channels → `defineFeature({ events })`
    ([webhooks and realtime](webhooks-and-realtime.md), "Domain events");
  - actions that need approval (`defineApproval()`) → `PlatformModule.forRoot({ approvals })`,
    their handlers, approver rules, modes and listeners register into `ApprovalsRegistry`;
  - tables → `features/tables.ts`; environment → `features/env.ts`;
  - exporters and importers register themselves (`DataTransferRegistry`);
  - what goes when a record is purged from its recycle bin: platform
    services register into `RecordPurgeRegistry` (iam), and
    SoftDeletePurgeJob calls them in the purge's transaction;
  - bulk operations register themselves (`BulkRegistry`);
  - retention rules (`RetentionRegistry`), AI sources (`AiRegistry`), PDF
    documents (`DocumentSource`) and naming-series subjects
    (`NamingSeriesService.register()`) register from a constructor;
  - lists register their declaration (`ListsRegistry`, `GET /v1/lists/{subject}`):
    `recordParts()` does it for a generated record, `listSource()` by hand;
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

- **Services own their queries, predicates included.** A controller passes
  the caller and the parsed query (`notes.findPage(user, list, query)`); the
  service composes `access.sqlFilter()` and `list.where()`. No controller
  imports `drizzle-orm` (oxlint `no-restricted-imports`). Drizzle is the data layer: typed tables and
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
