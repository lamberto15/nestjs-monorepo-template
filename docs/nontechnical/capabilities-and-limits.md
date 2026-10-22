# Capabilities and limits in plain language

This is a **summary of documented mechanisms, not a product-support promise**. Some modules are switched off by default, need providers or tenant-level enabling, and must be validated for a particular application. Follow each reference for implementation and operational prerequisites.

| Capability | What a user or organization gains | Constraints / where to learn more |
| --- | --- | --- |
| Accounts and authentication | Passwords, multi-factor and passkey options; social or enterprise sign-in | Provider configuration, recovery processes and policies matter. [Auth](../auth.md) |
| Roles, teams and permissions | Control who can do what, down to records and fields | Each new feature must declare and test its own permissions. [Permissions](../permissions.md) |
| Multi-organization support | Serve different organizations from one deployment | Requires correct tenant-aware data access and verification. [Tenancy](../tenancy.md) |
| Activity history | Track relevant changes with an audit trail | An audit log is not a substitute for governance or legal advice. [Permissions](../permissions.md) |
| API and typed client | Backend interface for web, scripts and other applications | API changes and version expectations require management. [API conventions](../api-conventions.md), [client](../../packages/api-client/README.md) |
| Web application | Sign-in and administrative pages, with an example record feature | Not a ready-made domain product; add your own pages. [Web app](../monorepo.md) |
| Files and records | Attachments, tags, comments, record revisions, custom fields | Storage, malware scanning and retention need configuration. [Attachments](../attachments.md), [retention](../retention.md) |
| Automated work | Queues, workflows, scheduled reports, approvals, webhooks | Workers and supporting services must run reliably. [Background work](../background-work.md), [approvals](../approvals.md) |
| Communication | Notifications, email, optional realtime/push/SMS | Provider costs, verification, deliverability and abuse controls are the adopter's responsibility. [Notifications](../notifications.md) |
| Data portability | Imports, exports, bulk actions and PDF document generation | Size, queue capacity, formats and authorization must be tested. [Data transfer](../data-transfer.md), [documents](../documents.md) |
| Optional AI | Asynchronous summarization or classification helper | Requires provider credentials and tenant enabling; review privacy and cost. [AI](../ai.md) |
| Operations | Containerized deployment, monitoring patterns, backups and rollback approaches | Requires infrastructure, secrets, recovery exercises and people on call. [Deployment](../deployment.md) |

## Switches and optional services

The first-run wizard asks about deployment shape and selected capabilities. The presence of a module in source control does not necessarily mean it is active. Deployment-level switches include tenancy, idempotency, webhooks, reports, usage accounting, realtime, multi-factor authentication, API clients and impersonation. Some authentication settings are adjustable at runtime within deployment limits. See [configuration](../configuration.md) and [settings](../settings.md).

For exact version- or branch-specific availability, check the [roadmap](../roadmap.md), [release notes](../releases.md) and corresponding implementation.

## Common misunderstandings

- **"The UI is complete."** It provides reusable and administrative UI, not the screens for your business domain.
- **"All features are free to operate."** Mail, cloud storage, external identity, AI, SMS, backups and hosting can have recurring costs.
- **"Multi-tenant means compliance is solved."** Isolation is a design capability; regulatory compliance depends on the deployed system and operating controls.
- **"Zero downtime means zero risk."** Any deployment still requires compatible migrations, health verification and a rollback plan.
- **"Open on GitHub means commercially open source."** Check the actual [noncommercial license](../../LICENSE).

Next: [Adoption and operations](adoption-and-operations.md).
