# Adoption, ownership and operating costs

## Before committing a team

This template reduces repeatable platform coding; it does **not** eliminate engineering ownership. Plan for an application owner, backend/frontend development, deployment responsibility and security review appropriate to the data handled.

### An incremental adoption path

1. **Evaluate fit and legal use.** Read the [decision guide](decision-guide.md) and [license](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/LICENSE). Obtain the required license/permission before commercial use.
2. **Prototype safely.** Use development data, run the application and build one real workflow. Confirm its permissions, import/export needs and integration points.
3. **Define what you own.** Remove the example notes feature, add domain-specific features and connect external systems. Put tests around business-critical behavior.
4. **Choose deployment and providers.** Decide where PostgreSQL, Redis, files, email and the application run; define responsibilities for backups and monitoring.
5. **Validate before launch.** Review security, workload, logging/redaction, migrations, disaster recovery, incident response and data-protection obligations.
6. **Operate and upgrade.** Track releases, dependency advisories, image updates, database changes, user support and scheduled recovery drills.

## Costs to estimate

| Cost area | Examples | Why it matters |
| --- | --- | --- |
| Engineering | Custom features, integrations, reviews, tests | The template is only a foundation |
| Runtime infrastructure | API, worker, PostgreSQL, Redis, object storage, reverse proxy | Some components are required even for simple deployments |
| Third-party services | Email, SSO provider, bot protection, AI, SMS, push | Availability and pricing vary by provider |
| Operations | Metrics, alerts, backups, recovery, capacity, secrets | A service needs ownership after first deployment |
| Governance | Access reviews, data retention, privacy/compliance assessment | Depends on data, geography and business use |
| License | Separate commercial permission if needed | The repository is not licensed for unrestricted commercial use |

No fixed monthly cost is specified: it depends on traffic, uptime requirements, vendor choice and staffing.

## Hosting shape

Development uses local Docker services. Production deployment is documented with Docker Compose (including rolling and blue-green patterns), Docker Swarm and a Kubernetes Helm chart. Those are deployment options, **not** evidence that every option is equally appropriate for your environment. Read [deployment](../deployment.md) and [Kubernetes limitations](../deploy-kubernetes.md) before selecting one.

## Risk and release policy

The repository's [roadmap](../roadmap.md) explicitly discusses an early stage in which breaking changes may occur. Do not treat the absence of a major release number as a stability guarantee. Track [releases](../releases.md) and use the [upgrading guide](../upgrading.md) when building on top of this template.

## Go / no-go criteria

A team should be able to demonstrate a working business use case, a responsible person for every required service, documented secrets and access controls, backup restoration, acceptable performance, legally permitted use and a sustainable update path. If those cannot be demonstrated, postpone production adoption.

If the evaluation succeeds, hand off to the [technical quickstart](../technical/quickstart.md) and [operations checklist](../technical/release-and-operations-checklist.md).
