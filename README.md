# NestJS REST backend template

A production-ready starting point for NestJS 12 REST APIs: everything a
project would otherwise rebuild is here, so a new project only writes its own
features. JSON in, JSON out; Swagger UI at `/api` is the only page.

A pnpm + Turborepo monorepo: the API in `apps/api`, its typed client in
`packages/api-client`, and room for your frontends in `apps/`
([monorepo](docs/monorepo.md)).

## What's in it

| Area | What you get | Docs |
| --- | --- | --- |
| Accounts | Password sign-in, sessions and tokens (mobile), sign-up (optional), invitations, email verification, forgot/reset/change password, TOTP two-factor with recovery codes, magic links, Google/Microsoft/GitHub, sessions list and sign-out everywhere, support impersonation | [auth](docs/auth.md) |
| Access | Roles of CASL permissions declared by features, conditions (mine, in my org units…), field-level permissions, role grants that expire, an org hierarchy, API clients with roles and rotating keys, an audit log with per-record diffs | [permissions](docs/permissions.md) |
| API | `/v1` versioning, RFC 9457 problem details, Zod validation and OpenAPI, cursor pagination, declared filters, idempotency keys, CORS, CSRF, security headers, rate limits | [conventions](docs/api-conventions.md) |
| Background | BullMQ queues on workers, mail through a queue, transactional outbox, durable workflows, cron on one instance (locks), outgoing and incoming webhooks, realtime (socket.io), exports and imports (CSV, JSON, Excel), PDF documents of records (Gotenberg, RTL and CJK fonts) | [background](docs/background-work.md), [data](docs/data-transfer.md), [documents](docs/documents.md) |
| Approvals | Declare "this action needs approval" once: multi-stage policies (any, all, quorum, your own modes), approvers by role, org unit, permission or your own rules, reminders and escalation, delegation, an inbox, policies changed at runtime and versioned, on durable workflows | [approvals](docs/approvals.md) |
| Platform | PostgreSQL 18 (UUIDv7 keys), Redis 8, file storage (local or S3, signed URLs), http-client with resilience, i18n (en, de, ar, zh, ms), time zones | [i18n and time](docs/i18n-and-time.md) |
| Money | Amounts as bigint minor units with their ISO 4217 currency (strings in the API), rounding modes (half-up by default, banker's), allocation without losing a cent, formatting in every locale, the ECB's daily rates and conversion through the euro | [money](docs/money.md) |
| Clients | A typed client package for web, mobile and scripts: REST types generated from the OpenAPI document, the conventions applied (credentials, idempotency keys, problem details, pages, ETags), typed realtime events | [api-client](packages/api-client/README.md) |
| Operations | Separate API and worker processes, health checks, JSON logs with request ids, NestJS Observe (optional), Docker Compose for development and production with resource limits, Caddy HTTPS, CI, Dependabot | [deployment](docs/deployment.md) |

One example feature, **notes**, is the model to copy: permissions with
conditions and fields, declared filters and pagination, an idempotent create,
audit diffs, a workflow, webhooks through the outbox, an incoming webhook,
realtime events, exports and imports. For the rest, see
`iam/audit/audit-retention.job.ts` (cron on one instance, locks) and
`iam/account/` (mail through `MailQueue`).

## Start

```bash
pnpm install
pnpm services:up          # PostgreSQL, Redis, Mailpit, Floci (AWS S3 and SES), Gotenberg (PDF)
cp apps/api/env.development.example apps/api/.env.development   # optional: point the app at them
pnpm start:dev            # http://localhost:3000/api
```

The first start creates the administrator (`ADMIN_EMAIL`; the password is
logged once unless `ADMIN_PASSWORD` is set). More in
[development](docs/development.md).

## Deploy

```bash
cp env.example .env && chmod 600 .env   # then fill it: domain, Cloudflare token, secrets
docker compose up -d --build
```

`env.example` says which values are required and how to generate each
secret.

Caddy (HTTPS) → `api` replicas; `worker` replicas for the background work;
PostgreSQL and Redis; migrations once per deploy. See
[deployment](docs/deployment.md) for staging, scaling and managed services.

## Documentation

- [Architecture](docs/architecture.md): the repository, the groups, the processes, how features plug in
- [Monorepo](docs/monorepo.md): the root scripts, Turborepo, adding a frontend app
- [Development](docs/development.md): setup, commands, tests, the typed client, the database
- [Adding a feature](docs/adding-a-feature.md): the checklist
- [API conventions](docs/api-conventions.md): versions, errors, lists, filters, credentials
- [Accounts and authentication](docs/auth.md)
- [Permissions](docs/permissions.md): roles, conditions, fields, grants, hierarchy, audit
- [Background work](docs/background-work.md): queues, mail, outbox, workflows, cron, realtime
- [Webhooks and realtime](docs/webhooks-and-realtime.md): outgoing and incoming webhooks, the ops API, socket.io, health
- [Exports and imports](docs/data-transfer.md)
- [PDF documents](docs/documents.md): templates, languages and right to left, Gotenberg, issued attachments
- [Custom fields](docs/custom-fields.md): fields administrators add at runtime, stored in JSONB
- [Languages and time](docs/i18n-and-time.md)
- [Configuration](docs/configuration.md): every variable
- [Deployment](docs/deployment.md)
- [Pitfalls](docs/pitfalls.md)
