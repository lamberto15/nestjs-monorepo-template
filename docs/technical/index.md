# Build and operate — technical documentation

**Audience:** software engineers, contributors, reviewers and platform operators. If you are evaluating fit or licensing, begin with the [nontechnical guide](../nontechnical/index.md) instead.

This index organizes the **existing deep technical references** by task. The links point directly to the living documentation; do not replace those sources with an abbreviated description.

## 1. Learn, run and extend

| Goal | Guide |
| --- | --- |
| Run API, web app and local services | [Quickstart](quickstart.md), [development](../development.md) |
| Understand services, packages and dependency boundaries | [System map](system-map.md), [architecture](../architecture.md), [monorepo](../monorepo.md) |
| Configure first-run options and environment | [Configuration](../configuration.md), [settings and flags](../settings.md) |
| Generate a business feature and sync it later | [Adding a feature](../adding-a-feature.md) |
| Work with errors, lists, versioning and the client | [API conventions](../api-conventions.md), [typed client](../../packages/api-client/README.md) |
| Run tests, worktrees, lint and load tests | [Development workflow](../development.md) |
| Avoid known mistakes | [Pitfalls](../pitfalls.md) |

## 2. Identity, data and access

| Topic | Guide |
| --- | --- |
| Users, sessions, OAuth, passkeys, SSO, SCIM, MFA | [Authentication](../auth.md) |
| Roles, grants, CASL, field access, teams and audit | [Permissions](../permissions.md) |
| Tenant context and PostgreSQL row-level security | [Tenancy](../tenancy.md) |
| Encryption, blind indexes and key rotation | [Encryption](../encryption.md) |
| Retention rules and legal holds | [Retention](../retention.md) |
| Localization, dates and time zones | [i18n and time](../i18n-and-time.md) |
| Currency-safe calculations | [Money](../money.md) |
| Usage tracking and client quotas | [Usage](../usage.md) |

## 3. Platform extension

| Topic | Guide |
| --- | --- |
| Background jobs, workflows, outbox and cron | [Background work](../background-work.md) |
| Webhooks and realtime events | [Webhooks and realtime](../webhooks-and-realtime.md) |
| Approval policies | [Approvals](../approvals.md) |
| Notifications and channels | [Notifications](../notifications.md) |
| Tags, comments, attachments and revisions | [Tags](../tags.md), [comments](../comments.md), [attachments](../attachments.md), [revisions](../revisions.md) |
| Runtime record fields and custom user views | [Custom fields](../custom-fields.md), [saved views](../saved-views.md) |
| Sequences and numbering | [Sequences](../sequences.md) |
| Imports, exports, bulk changes and reports | [Data transfer](../data-transfer.md), [bulk operations](../bulk-operations.md), [reports](../reports.md) |
| PDF rendering | [Documents](../documents.md) |
| AI processing | [AI](../ai.md) |
| Email delivery and suppression | [Deliverability](../deliverability.md) |
| Tenant appearance settings | [Branding](../branding.md) |

## 4. Deploy, protect and upgrade

| Goal | Guide |
| --- | --- |
| Prepare a release and a deployment | [Operations checklist](release-and-operations-checklist.md), [deployment](../deployment.md) |
| Docker Compose updates | [Rolling](../deploy-rolling.md), [blue-green](../deploy-blue-green.md) |
| Other orchestrators | [Swarm](../deploy-swarm.md), [Kubernetes / Helm](../deploy-kubernetes.md) |
| Migrations, backups, monitoring, secrets, CI | [Deployment](../deployment.md) |
| Cut versions and publish images | [Releases](../releases.md) |
| Merge template changes into adopted projects | [Upgrading](../upgrading.md) |
| Know what's delivered or planned | [Roadmap](../roadmap.md) |
| Report security issues privately | [Security policy](../../SECURITY.md) |
| Contribute code or documentation | [Contributing](../../CONTRIBUTING.md), [docs maintenance](../documentation-maintenance.md) |

## Usage

Start with [quickstart](quickstart.md) for a runnable path, [system map](system-map.md) for explanations, task-specific pages for how-to instructions, and the topic references above for exact rules. The [documentation tooling proposal](../documentation-tooling.md) explains how this structure can become a searchable website without changing the canonical source pages.
