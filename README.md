# NestJS REST backend template

> **Start here:** [Documentation home](docs/index.md) · [Nontechnical: evaluate the template](docs/nontechnical/index.md) · [Technical: build and operate](docs/technical/index.md)
>
> New to this project? Read the [decision guide](docs/nontechnical/decision-guide.md) before installing it. This is a customizable foundation, not a complete business application. **Commercial-use rights are not granted by default:** review the [PolyForm Noncommercial license](LICENSE) and obtain separate permission if required.

A production-ready starting point for NestJS 12 REST APIs: everything a
project would otherwise rebuild is here, so a new project only writes its own
features. JSON in, JSON out; Swagger UI at `/api` is the API's only page.

You choose the shape once, with the first-run wizard (`pnpm setup`: one
organization or many, which optional services and security switches are on);
you add features with a generator (`pnpm feature:add`) that writes everything
standard, so you write only the business logic; and you deploy without
downtime with Docker Compose (rolling or blue-green) or Docker Swarm.

A pnpm + Turborepo monorepo: the API in `apps/api`, its typed client in
`packages/api-client`, a web app on that client in `apps/web` (React, Vite,
TanStack Router and Query, shadcn/ui and Dice UI from `packages/ui`), and
room for more frontends in `apps/` ([monorepo](docs/monorepo.md)).

## What's in it

| Area            | What you get                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Docs                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup           | `pnpm setup`: a first-run wizard that asks the deployment shape and the few choices, lets you disable unused modules and writes the env file with generated secrets                                                                                                                                                                                                                                                                                                                                                                                                                     | [configuration](docs/configuration.md)                                                                                                                                                                                                                                                                   |
| Choices         | Deployment switches, set once: one tenant or many (`TENANCY`), `IDEMPOTENCY` (required or optional), `WEBHOOKS`, `REPORTS`, `USAGE`, `REALTIME`, `AUTH_MFA`, `API_CLIENTS`, `IMPERSONATION` (off by default); auth policies changed at runtime (`auth.requireMfa`, `auth.passwordMinLength`) under the env's ceiling                                                                                                                                                                                                                                                                    | [configuration](docs/configuration.md), [settings](docs/settings.md)                                                                                                                                                                                                                                     |
| Features        | A generator (`pnpm feature:add`, the `/add-feature` skill for Claude Code) writes a feature from one declaration, `<item>.record.ts`: fields, recycle bin, organizational units, and capabilities (tags, comments, attachments, revisions, PDF, bulk, watch, search, export, custom fields, webhooks for its changes, gapless numbers), approvals and settings, plus API-key access, grants and idempotency; `pnpm feature:sync` applies a changed declaration later                                                                                                                    | [adding a feature](docs/adding-a-feature.md)                                                                                                                                                                                                                                                             |
| Tenants         | Many organizations in one deployment behind PostgreSQL row-level security (or one, with `TENANCY=single`), the tenant of every request, job, workflow and cron run, operators, independent tenants with strict isolation, break-glass (an operator reading a tenant read only), platform analytics on anonymized aggregates                                                                                                                                                                                                                                                             | [tenancy](docs/tenancy.md)                                                                                                                                                                                                                                                                               |
| Accounts        | Password sign-in, sessions and tokens (mobile), passkeys, sign-up (optional), invitations, email verification, forgot/reset/change password, TOTP two-factor with recovery codes, magic links, Google/Microsoft/GitHub, enterprise SSO (SAML 2.0, OpenID Connect per tenant) with SCIM 2.0 provisioning, bot protection (Turnstile), sessions list and sign-out everywhere, data export and account deletion, support impersonation (opt in)                                                                                                                                            | [auth](docs/auth.md)                                                                                                                                                                                                                                                                                     |
| Access          | Roles of CASL permissions declared by features, conditions (mine, in my units…), field-level permissions, role grants that expire, organizational units, API clients with roles and rotating keys, an audit log with per-record diffs                                                                                                                                                                                                                                                                                                                                                   | [permissions](docs/permissions.md)                                                                                                                                                                                                                                                                       |
| API             | `/v1` versioning, RFC 9457 problem details, Zod validation and OpenAPI, cursor pagination, declared filters, idempotency keys, CORS, CSRF, security headers, rate limits, per-client daily quotas                                                                                                                                                                                                                                                                                                                                                                                       | [conventions](docs/api-conventions.md), [usage](docs/usage.md)                                                                                                                                                                                                                                           |
| Background      | BullMQ queues on workers, mail through a queue, transactional outbox, durable workflows, cron on one instance (locks), outgoing and incoming webhooks, realtime (socket.io), exports and imports (CSV, JSON, Excel), bulk operations as 202 jobs, scheduled reports, PDF documents of records (Gotenberg, RTL and CJK fonts), email deliverability (SES bounces and complaints, a suppression list)                                                                                                                                                                                     | [background](docs/background-work.md), [webhooks and realtime](docs/webhooks-and-realtime.md), [data](docs/data-transfer.md), [bulk](docs/bulk-operations.md), [reports](docs/reports.md), [documents](docs/documents.md), [deliverability](docs/deliverability.md)                                      |
| Records         | Tags, comments with @mentions, file attachments, revisions (history, diff, restore), custom fields added at runtime, notifications (in-app, realtime, mail, webhook, push, SMS; preferences, digests), saved views of lists, settings and feature flags (rollouts, kill switches), gapless human-readable numbers and naming series administrators define                                                                                                                                                                                                                               | [tags](docs/tags.md), [comments](docs/comments.md), [attachments](docs/attachments.md), [revisions](docs/revisions.md), [custom fields](docs/custom-fields.md), [notifications](docs/notifications.md), [saved views](docs/saved-views.md), [settings](docs/settings.md), [sequences](docs/sequences.md) |
| Data protection | Encrypted columns for personal data (AES-256-GCM, blind indexes, key rotation with a re-encryption job), retention rules (purge or anonymise after N days, per tenant) and legal holds that block deletes and purges                                                                                                                                                                                                                                                                                                                                                                    | [encryption](docs/encryption.md), [retention](docs/retention.md)                                                                                                                                                                                                                                         |
| AI              | An AI helper that summarizes or classifies a record on a queue worker (off until a key is set and a tenant turns it on), with a token quota and a cache                                                                                                                                                                                                                                                                                                                                                                                                                                 | [ai](docs/ai.md)                                                                                                                                                                                                                                                                                         |
| Approvals       | Declare "this action needs approval" once: multi-stage policies (any, all, quorum, your own modes), approvers by role, organizational unit, permission or your own rules, reminders and escalation, delegation, an inbox, policies changed at runtime and versioned, on durable workflows                                                                                                                                                                                                                                                                                               | [approvals](docs/approvals.md)                                                                                                                                                                                                                                                                           |
| Platform        | PostgreSQL 18 (UUIDv7 keys), Redis 8, file storage (local or S3, signed URLs), http-client with resilience, i18n (en, de, ar, zh, ms), time zones                                                                                                                                                                                                                                                                                                                                                                                                                                       | [i18n and time](docs/i18n-and-time.md)                                                                                                                                                                                                                                                                   |
| Money           | Amounts as bigint minor units with their ISO 4217 currency (strings in the API), rounding modes (half-up by default, banker's), allocation without losing a cent, formatting in every locale, the ECB's daily rates and conversion through the euro                                                                                                                                                                                                                                                                                                                                     | [money](docs/money.md)                                                                                                                                                                                                                                                                                   |
| Web app         | A React single-page app on the typed client, served by Caddy beside the API: sign-in with every method (SSO included), the account pages, users, roles, organization structure and grants, single sign-on and SCIM, tenants (operators), API clients and usage, webhooks, approvals and their policies, notifications, settings and flags, naming series, custom fields, tags, the audit log, operations, global search, saved views, exports, imports, scheduled reports and bulk operations, and the example feature's list and record pages (tags, comments, attachments, revisions) | [monorepo](docs/monorepo.md#the-web-app)                                                                                                                                                                                                                                                                 |
| Clients         | A typed client package for web, mobile and scripts: REST types generated from the OpenAPI document, the conventions applied (credentials, idempotency keys, problem details, pages, ETags), typed realtime events                                                                                                                                                                                                                                                                                                                                                                       | [api-client](packages/api-client/README.md)                                                                                                                                                                                                                                                              |
| Operations      | Separate API and worker processes, health checks, JSON logs with request ids and redaction, Prometheus metrics and alert rules, backups, Docker Compose for development and production with resource limits, Caddy HTTPS, CI with scans, published images, Dependabot                                                                                                                                                                                                                                                                                                                   | [deployment](docs/deployment.md)                                                                                                                                                                                                                                                                         |
| Deploys         | Zero-downtime deploys three ways, with graceful shutdown and Caddy holding requests while replicas restart: rolling (`pnpm deploy:rolling`), blue-green with an instant rollback (`pnpm deploy:blue-green`), Docker Swarm with automatic rollback (`pnpm deploy:swarm`)                                                                                                                                                                                                                                                                                                                 | [deployment](docs/deployment.md#zero-downtime-deploys-three-ways), [rolling](docs/deploy-rolling.md), [blue-green](docs/deploy-blue-green.md), [Swarm](docs/deploy-swarm.md)                                                                                                                             |

One example feature, **notes**, shows business logic on top of the platform:
a publish workflow with an approval, conditions and field-level permissions,
numbers, custom fields, webhooks through the outbox, an incoming webhook,
settings. It is there to read, then to remove (`pnpm feature:remove notes`;
CI proves the template stands without it): new features start from the
generator (`pnpm feature:add`), never from a copy.

## Start

```bash
pnpm install
pnpm setup                # first run: a few questions, writes apps/api/.env.development (or the root .env: --target production)
pnpm services:up          # PostgreSQL, Redis, Mailpit, Floci (AWS S3 and SES), Gotenberg (PDF)
pnpm dev                  # the API (http://localhost:3000/api) and the web app (http://localhost:5173)
pnpm db:seed:demo         # optional, from a second terminal: demo users and organizational units, and each feature's demo data (passwords printed once)
```

Open http://localhost:5173 and sign in as the administrator (below) or a
demo member the seed printed ([monorepo](docs/monorepo.md#running-it)).

`pnpm setup` asks what shapes a project (one organization or many, mail,
storage, sign-up, bot protection, the deployment switches), keeps the
rest off, and generates the secrets; without it, copy `apps/api/env.development.example` to
`apps/api/.env.development` by hand ([configuration](docs/configuration.md),
"First setup"). The first start creates the administrator (`ADMIN_EMAIL`; the password is
logged once unless `ADMIN_PASSWORD` is set, which `pnpm setup` does). Or open
the repository in its devcontainer (`.devcontainer/`): the same services,
nothing to install; `pnpm dev` runs the API and the web app there. More in
[development](docs/development.md).

## Start a new project

```bash
git clone https://github.com/lamberto15/nestjs-monorepo-template my-app   # keeps the history: template updates merge
cd my-app && git remote rename origin template
pnpm install
pnpm feature:remove notes   # the example feature: the API's and the web app's (pages, tests, texts)
pnpm db:generate            # the migration that drops its table
pnpm feature:add invoices --fields "number:string!unique,total:money,dueOn:date?" --with tags,comments,attachments,pdf
pnpm db:generate && pnpm client:generate
pnpm build                  # the web's build regenerates its route tree
```

Then run `pnpm setup` and rename it (the root `package.json` `name`, the `@nestjs-monorepo-template/`
scope, `API_TITLE`, `API_KEY_PREFIX`) and write only the business logic, where
the generated service says so. With Claude Code, `/add-feature` asks what the
feature needs and runs the generator. GitHub's "Use this template" works too,
but its fresh history makes template updates harder ([upgrading](docs/upgrading.md)).
More in [adding a feature](docs/adding-a-feature.md).

## Deploy

```bash
pnpm setup --target production           # asks, writes .env (chmod 600) with every secret generated
docker compose up -d --build             # the first start; later deploys: one of the three below
```

By hand instead: `cp env.example .env && chmod 600 .env`; `env.example` says
which values are required and how to generate each secret.

Caddy (HTTPS, and the web app's files) → `api` replicas; `worker` replicas
for the background work; PostgreSQL and Redis; migrations once per deploy. Later deploys keep serving
while the new version starts ([deployment](docs/deployment.md#zero-downtime-deploys-three-ways)):

| Method               | Command                  | Rollback                                                            |
| -------------------- | ------------------------ | ------------------------------------------------------------------- |
| Rolling (Compose)    | `pnpm deploy:rolling`    | deploy the previous `APP_IMAGE`                                     |
| Blue-green (Compose) | `pnpm deploy:blue-green` | `pnpm deploy:blue-green rollback`, instant                          |
| Docker Swarm         | `pnpm deploy:swarm`      | automatic on a failed health check, or `pnpm deploy:swarm rollback` |

See [deployment](docs/deployment.md) for staging, scaling, managed services,
backups and the published images.

## Template updates

The template keeps shipping fixes and modules as releases (`v*` tags, with
notes on their migrations and how to roll back). Start your project with
`git clone` (keeping the history), keep the template as a remote, and merge
each release tag: [upgrading](docs/upgrading.md).

```bash
git remote add template https://github.com/lamberto15/nestjs-monorepo-template
git fetch template --tags && git merge v1.3.0
```

## Documentation

Getting started

- [Development](docs/development.md): setup, commands, tests, the demo seed, the typed client, the database, the git workflow
- [Configuration](docs/configuration.md): `pnpm setup` and every variable
- [Architecture](docs/architecture.md): the repository, the groups, the processes, how features plug in
- [Monorepo](docs/monorepo.md): the root scripts, Turborepo, the web app (running it, its pages, its tests), adding a frontend app

Building features

- [Adding a feature](docs/adding-a-feature.md): the generator, the `<item>.record.ts` declaration, the checklist
- [API conventions](docs/api-conventions.md): versions, errors, lists, filters, credentials, idempotency
- [Accounts and authentication](docs/auth.md): sign-in, tokens, passkeys, two-factor, enterprise SSO and SCIM, API clients, impersonation
- [Permissions](docs/permissions.md): roles, conditions, fields, grants, organizational units, audit
- [Tenancy](docs/tenancy.md): tenants, the row-level security wall, single-tenant deployments
- [Languages and time](docs/i18n-and-time.md)
- [Pitfalls](docs/pitfalls.md): mistakes already made

Platform modules

- [Background work](docs/background-work.md): queues, mail, outbox, workflows, cron
- [Webhooks and realtime](docs/webhooks-and-realtime.md): outgoing and incoming webhooks, the ops API, socket.io, health
- [Exports and imports](docs/data-transfer.md)
- [Bulk operations](docs/bulk-operations.md): delete, restore or change many records as a 202 job
- [Duplicates and merging](docs/merging.md): likely duplicates by declared rules, a previewed, audited merge
- [Scheduled reports](docs/reports.md): an export on a schedule, mailed with a link
- [PDF documents](docs/documents.md): templates, languages and right to left, Gotenberg, issued attachments
- [Approvals](docs/approvals.md): policies, stages, approver rules, delegation, escalation
- [Notifications](docs/notifications.md): in-app, realtime, mail, webhook, push and SMS; preferences, digests
- [Settings and feature flags](docs/settings.md): runtime values, scopes, rollouts
- [Custom fields](docs/custom-fields.md): fields administrators add at runtime, stored in JSONB
- [Tags](docs/tags.md), [Comments](docs/comments.md), [Attachments](docs/attachments.md), [Revisions](docs/revisions.md): what any record can carry
- [Sequences](docs/sequences.md): gapless human-readable numbers, naming series
- [Saved views](docs/saved-views.md): a list's filters, sort and columns kept by name
- [Encrypted columns](docs/encryption.md): personal data at rest, blind indexes, key rotation
- [Retention](docs/retention.md): purge or anonymise after N days, legal holds
- [AI helper](docs/ai.md): summarize or classify a record on a queue worker
- [Money](docs/money.md): minor-unit amounts, rounding, allocation, formatting, exchange rates
- [Usage and quotas](docs/usage.md): API clients' usage per day and route, daily quotas
- [Email deliverability](docs/deliverability.md): SPF, DKIM, DMARC, bounces, the suppression list

Operations and deploys

- [Deployment](docs/deployment.md): Compose, staging, scaling, secrets, metrics and alerts, backups, CI, published images
- [Rolling deploys](docs/deploy-rolling.md): `pnpm deploy:rolling`
- [Blue-green deploys](docs/deploy-blue-green.md): `pnpm deploy:blue-green`, instant rollback
- [Docker Swarm](docs/deploy-swarm.md): `pnpm deploy:swarm`, automatic rollback

Releases and the roadmap

- [Releases](docs/releases.md): template releases and their notes, the typed client's versions (Changesets)
- [Upgrading](docs/upgrading.md): pulling template updates into your project (the merge, conflicts, migrations)
- [Roadmap](docs/roadmap.md): what gets built next, and the status of what is done

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal, research, education and other
noncommercial use. Commercial use needs a separate licence from the copyright holder.
