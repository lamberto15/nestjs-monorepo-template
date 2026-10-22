# What this project is (and is not)

## The problem it targets

When teams start a serious backend application, they often rebuild the same platform capabilities: sign-in, permissions, audit history, file handling, jobs, API conventions, observability and deployment. This repository offers an opinionated starting point for those concerns.

Instead of starting with a blank NestJS application, a development team can begin with a functioning REST API, a companion React frontend, reusable UI components, a typed API client and an example feature. The team then removes or replaces the example and implements its own business processes.

## What is included

The repository provides a **developer template**, with source code and guides for:

- Identity and access: accounts, authentication options, roles, teams and API clients.
- Application foundations: records, audit logs, files, notifications, imports/exports and workflow-like jobs.
- Tenant-aware design: single-organization or multi-organization configuration with database-backed separation.
- Developer tooling: guided setup, feature generation, tests and client generation.
- Operations: containers, migrations, observability, backups and deployment approaches.
- A browser application to interact with the platform and example capabilities.

For a current, categorized list, see [capabilities and limits](capabilities-and-limits.md) and the [repository README](../../README.md).

## What is not included

It is **not** an already-hosted service, a commercial-license grant, a compliance certificate, a promise of zero operational expense or a ready-made implementation of any industry's business rules. The included "notes" feature is a demonstration, not a complete product.

"Production-ready starting point" describes engineering intent, **not** automatic fitness for every real-world production workload. A team must review its threat model, required availability, traffic, data privacy obligations, deployment architecture, incident response and service-provider integrations.

## Who does what

| Responsibility | Template provides | Adopting team provides |
| --- | --- | --- |
| Shared platform plumbing | Reusable code and configurable modules | Configuration, testing, upgrades |
| Business requirements | Example extension pattern | Domain models, rules, workflows and interfaces |
| Data and users | Storage and access mechanisms | Data governance, policies, permissions and ownership |
| Infrastructure | Compose and orchestration examples | Hosting, credentials, monitoring, capacity and recovery |
| Security | Security-oriented controls and tests | Security review, operational hardening and compliance decisions |
| Support | Repository documentation and issue workflow | Support for the application built from the template |

Continue to the [decision guide](decision-guide.md) before installing anything.
