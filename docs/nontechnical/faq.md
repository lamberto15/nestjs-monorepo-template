# Frequently asked questions

## Is this a complete application?

No. It includes a NestJS API, React frontend, administrative and platform capabilities, and an example notes feature. You still create the features, data rules and interfaces for the specific business.

## Can I use it for a company or a paid product?

**Do not assume so.** The repository contains the [PolyForm Noncommercial 1.0.0 license](../../LICENSE). Commercial use needs permission under separate terms from the copyright holder. Evaluate your particular use with appropriate legal advice; a public GitHub repository is not necessarily licensed for commercial reuse.

## Is it only a NestJS backend?

No. NestJS is the API backend, and a React/Vite web app, typed client and reusable UI package are in the same workspace. The API itself serves JSON plus Swagger UI. See [monorepo](../monorepo.md).

## Can I use it for just one organization?

Yes. The setup exposes a single-tenant option as well as multi-tenant deployment. Review its design and migration implications in [tenancy](../tenancy.md) before choosing.

## Is everything enabled automatically?

No. Setup switches and feature flags determine what is enabled. Some functions need credentials, worker processes, mail, storage or other providers. See [configuration](../configuration.md).

## Do I need Docker and a database?

The documented development workflow uses Docker Compose for services such as PostgreSQL and Redis, with Node.js and pnpm for the application. Production deployment needs corresponding services, whether containerized or managed. See [development](../development.md).

## Does it support APIs for mobile apps?

The API exposes REST routes, and the repository includes a typed client meant for clients beyond the bundled web app. A complete native mobile app is not supplied. See [API conventions](../api-conventions.md) and [client package](../../packages/api-client/README.md).

## Does it come with support, hosting or a guaranteed SLA?

No hosting or SLA is granted by the repository. The adopter is responsible for its own application operations. The [security policy](../../SECURITY.md) covers reporting vulnerabilities in the template, not support contracts for applications derived from it.

## Can I pull future template improvements into my project?

The repository documents a history-preserving clone and a release-tag merge strategy. Updates can conflict with your own changes and may require migration work. Read [upgrading](../upgrading.md) before creating your project.

## Where can I see the latest limitations and release changes?

Use the [roadmap](../roadmap.md), [releases guide](../releases.md), [GitHub releases](https://github.com/lamberto15/nestjs-monorepo-template/releases) and [open issues](https://github.com/lamberto15/nestjs-monorepo-template/issues). These change more often than an introductory page.

## I'm an engineer. Where should I start?

Go to [technical quickstart](../technical/quickstart.md) and [technical index](../technical/index.md), not this evaluation section.
