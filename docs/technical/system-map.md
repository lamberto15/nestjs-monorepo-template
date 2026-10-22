# System map: the big picture

This page is an architectural orientation. For exact NestJS modules, source locations and extension contracts, read [architecture](../architecture.md).

## Repository boundaries

```text
User / browser
     |
     v
Caddy (production reverse proxy + static web app)
     |                         React frontend (apps/web)
     |                                  |
     +----------------------------- REST client (packages/api-client)
                                        |
                                        v
                                NestJS API (apps/api)
                                  |       |       |
                                  |       |       +--> queues / events
                                  |       |                  |
                                  v       v                  v
                             PostgreSQL Redis           worker role
                                  |                        |
                                  +------ shared state ----+
                                        |
                              optional service integrations
                          (storage, mail, PDF, SSO, AI, webhooks)
```

*Conceptual topology, not an exact deployment network diagram.* Development services differ from production, and optional integrations only run when configured. Production orchestration options are documented in [deployment](../deployment.md).

## Four code layers

| Layer | Role | May depend on |
| --- | --- | --- |
| `core` | HTTP, configuration, database, tenancy, logging, queues | Core/framework primitives |
| `iam` | Identity, authentication, authorization, audit, membership | Core |
| `platform` | Reusable records, integrations, workflows and services | Core, IAM |
| `features` | Business-domain modules declared by an application | Core, IAM, platform |

The intended dependency direction is **core ← iam ← platform ← features**. Shared layers must not import business features. The template's registration points let features declare their permissions, events, queues, custom fields and other extensions without reversing that boundary. See [architecture](../architecture.md) and [feature guide](../adding-a-feature.md).

## A typical request

1. A browser or client calls a versioned REST endpoint under `/v1`.
2. HTTP middleware/guards apply authentication, tenant selection, validation, authorization and any configured API protections.
3. The controller delegates to a feature or platform service.
4. The service reads/writes via the transaction host and the correct tenant scope; relevant changes include audit records.
5. The API returns a response following the [API conventions](../api-conventions.md). Slow jobs return an asynchronous handle rather than blocking on heavy work.

Do not treat this numbered overview as a replacement for the exact guard/interceptor order or transaction policies in [architecture](../architecture.md) and [pitfalls](../pitfalls.md).

## Async and events

Worker processes handle queues separately from serving HTTP. For reliable side effects, the platform uses a transactional outbox and workflow/job mechanisms. Webhooks, notifications, documents, imports/exports, report generation and some other activities cross this boundary. The queue and outbox do not remove the need for retry-safe handlers, observability and worker capacity planning.

Read [background work](../background-work.md), [webhooks and realtime](../webhooks-and-realtime.md) and [deployment](../deployment.md).

## Multi-tenancy and access

The design combines tenant context with PostgreSQL row-level security, while roles and resource permissions govern actions and visible fields. A correct custom feature must carry tenant context through requests, jobs and scheduled operations and define its permissions explicitly. See [tenancy](../tenancy.md) and [permissions](../permissions.md). Do not bypass the documented access patterns to query tenant tables directly.

## Generated versus maintained by hand

The feature generator creates a conventional starting point, the database tooling generates migrations, the API client is generated from OpenAPI, and the web router maintains a generated route tree. Edit declarations/business logic and run their generators; **do not hand-edit generated artifacts**. See [feature guide](../adding-a-feature.md), [development](../development.md) and [monorepo](../monorepo.md).

## Deployment responsibility

The repository has a configured API process, worker processes, database, cache, proxy and optional dependencies. Adopted projects must decide scale, authentication provider, backup topology, monitoring and restore procedures. The production stack is not simply the development container with a public port. Use the [operations checklist](release-and-operations-checklist.md).
