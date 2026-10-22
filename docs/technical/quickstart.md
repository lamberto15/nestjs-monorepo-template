# Quickstart: API, web app and local services

**Outcome:** run the template locally and identify the example feature before beginning custom development. This is the short path; [development](../development.md) is the authoritative detailed guide.

## Prerequisites

Use Node.js 24, pnpm matching the workspace's declared version (see root `package.json`), Git and Docker with the Compose plugin. The repository can also be opened in the supplied devcontainer instead of installing the host toolchain.

## Start the workspace

Run these commands from the repository root:

```bash
pnpm install
pnpm setup
pnpm services:up
pnpm dev
```

The interactive wizard writes development configuration, including generated secrets; the services command starts PostgreSQL, Redis and local service emulators. Open:

- Web UI: http://localhost:5173
- Swagger UI: http://localhost:3000/api
- Mailpit (test messages): http://localhost:8025

On first boot the application creates an administrator based on the configured `ADMIN_EMAIL`. Read the generated setup values and [administrator onboarding](../auth.md) before signing in. Do not commit generated `.env` files.

Optional demo data, in another terminal:

```bash
pnpm db:seed:demo
```

This is for a **development database only**; do not use it to populate production. See [demo data](../development.md) for the tenant, generated users and passwords.

## Orient yourself

- `apps/api` — NestJS API, worker and generated Drizzle migrations.
- `apps/web` — React/Vite SPA using TanStack Router and the shared UI components.
- `packages/api-client` — generated REST types and client.
- `packages/ui` — reusable frontend components.
- `tools/feature` — feature generator; do not copy the example feature by hand.
- `docs/` — technical references; this page is an entry point.

Read the [system map](system-map.md) for the request, database and job boundaries.

## Create your first domain feature

The repository's example `notes` feature demonstrates common capabilities. In a new project you can remove it and generate your own feature using the documented commands:

```bash
pnpm feature:remove notes
pnpm db:generate
pnpm feature:add invoices --fields "number:string!unique,total:money,dueOn:date?" --with tags,comments,attachments,pdf
pnpm db:generate
pnpm client:generate
pnpm build
```

**Do not run the removal sequence against a database with real notes data.** These are examples for a fresh derived project, not instructions to delete data in an existing deployment. Use [adding a feature](../adding-a-feature.md) for declaration syntax, migrations, permissions and actual business logic.

## Validate a change

```bash
pnpm build
pnpm lint
pnpm test
pnpm test:e2e
pnpm db:check
pnpm client:check
```

Browser e2e tests are documented under `pnpm test:e2e:web`. Some suites require running services and sufficient resources. CI remains the source of truth for the repository's required checks; see [development](../development.md) and [deployment CI](../deployment.md).

## Common problems

| Symptom | First check |
| --- | --- |
| Cannot connect to PostgreSQL or Redis | `pnpm services:up`, Docker status, and [development's environment-file separation](../development.md) |
| Swagger loads but no authenticated requests work | Administrator onboarding, credentials, session/tenant selection, [auth](../auth.md) |
| Generated API client does not match routes | `pnpm client:generate` and [API conventions](../api-conventions.md) |
| Migration mismatches | [Database and migration rules](../development.md), [pitfalls](../pitfalls.md) |
| Worker-dependent job never completes | API/worker roles, Redis and queues in [background work](../background-work.md) |
| A capability returns "unavailable" | Setup switches, providers and [configuration](../configuration.md) |

For production, **do not simply deploy this development setup**. Follow the [operations checklist](release-and-operations-checklist.md) and [deployment guide](../deployment.md).
