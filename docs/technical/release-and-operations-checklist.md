# Release and operations checklist

**Purpose:** a human review checklist for a project built from this template. It is not a replacement for the deployment instructions, a security audit or organization-specific policy.

## Before first production deployment

- [ ] **Legal and scope:** verify the [license](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/LICENSE), ownership of the derived application, feature scope, data classification and support arrangements.
- [ ] **Environment:** create production settings using [`pnpm setup --target production`](../configuration.md); review every secret/provider and the chosen feature switches; keep secrets outside source control.
- [ ] **Infrastructure:** choose the supported deployment path in [deployment](../deployment.md) and provision PostgreSQL, Redis, API, workers, storage, reverse proxy/TLS and configured optional dependencies.
- [ ] **Identity and permissions:** review admin onboarding, MFA/SSO, recovery, tenant isolation, account provisioning, API clients and feature access rules. See [auth](../auth.md), [permissions](../permissions.md) and [tenancy](../tenancy.md).
- [ ] **Data protection:** establish retention, encryption keys and key rotation, backups, any required privacy controls and legal holds. See [encryption](../encryption.md), [retention](../retention.md).
- [ ] **External integrations:** validate mail sender and bounce handling, object storage, webhooks, SSO, PDF service and any opted-in AI/SMS/push service. See [deliverability](../deliverability.md).
- [ ] **Monitoring:** test health checks, metrics, alert delivery, log redaction and access to diagnostic logs. See [deployment](../deployment.md).
- [ ] **Recovery:** verify backup integrity and **practice a restore**; document RPO/RTO targets, escalation and image rollback plans. See [deployment](../deployment.md).
- [ ] **Performance:** run representative integration and load tests; set worker/queue capacity, rate limits and memory budgets based on measurements. See [development](../development.md).

## Every pull request

- [ ] Use the repository's worktree + branch + PR workflow (do not commit directly to `main`).
- [ ] Check the required CI jobs, not only build and unit tests; [CI](../deployment.md) covers security, migrations and API compatibility.
- [ ] Run relevant lint, tests, web browser tests, database checks and client-generation checks.
- [ ] Document the user-visible behavior, configuration additions, feature switches and operational changes.
- [ ] If an API or schema contract changes, check consumer impact and the [expand/contract migration guidance](../pitfalls.md).
- [ ] Review idempotency, tenant scoping, data exposure, audit behavior and worker retries for affected features.

## Every release / deployment

1. Read [release notes](../releases.md), check pinned image digests/tags and any breaking change or migration.
2. Confirm that CI passed for the exact code being deployed.
3. Back up and verify the recovery point; confirm adequate capacity and healthy dependencies.
4. Use the chosen [rolling](../deploy-rolling.md), [blue-green](../deploy-blue-green.md), [Swarm](../deploy-swarm.md) or [Helm](../deploy-kubernetes.md) procedure; do not substitute one method's rollback assumptions for another.
5. Verify migration success, application health, worker processing, tenant-scoped smoke tests, authentication and critical flows.
6. Observe metrics/errors/queue lag and log redaction. Roll back **only after assessing schema compatibility**: reverting the image does not roll back the database schema.
7. Record deployed versions, incidents, changes and follow-up actions.

## Periodic upkeep

Review dependency and security updates, unused secrets and API keys, operator access, tenant access, retention runs, notification providers, capacity and restore drills. Treat stale documentation as a defect. See [documentation maintenance](../documentation-maintenance.md).

For detailed commands and caveats, read [deployment](../deployment.md), [releases](../releases.md), [upgrading](../upgrading.md) and [security policy](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/SECURITY.md).
