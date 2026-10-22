# Implementation audit — source-verified snapshot

**Code baseline:** [main at 17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6](https://github.com/lamberto15/nestjs-monorepo-template/commit/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6), reviewed October 22, 2026.

This audit inspected the repository tree plus representative application source, setup scripts, manifests, Compose files and CI workflows. The tree includes over 2,000 source/configuration files. **It is not a line-by-line audit of every module, successful test run or production certification.** Each row distinguishes source code evidence from what remains untested.

## Claim-to-code verification

| Documentation claim | Implementation evidence | Finding |
| --- | --- | --- |
| Monorepo boundaries | [workspace](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/pnpm-workspace.yaml), [API manifest](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/package.json), [web manifest](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/web/package.json) | Confirmed NestJS API, React/Vite SPA, typed API client and shared UI packages; no UI smoke test |
| API and worker roles | [main.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/main.ts), [worker.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/worker.ts), [production Compose](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/compose.prod.yaml) | Confirmed worker-only entry point and separate deploy roles; not benchmarked |
| Dependency layers | [app.module.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/app.module.ts), [feature.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/features/feature.ts) | Confirmed composition and declared extension points; not a global import-graph audit |
| Feature generator vs example | [feature index](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/features/index.ts), [notes.feature.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/features/notes/notes.feature.ts), [feature:add](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/tools/feature/add.mjs) | Example notes is hand-written; generated features follow the add/sync tooling |
| Wizard and secret generation | [setup.mjs](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/tools/setup/setup.mjs), [plan.mjs](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/tools/setup/plan.mjs) | Confirmed code paths for development/production env files and questions; wizard not executed |
| On-by-default platform switches | [platform.env.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/platform/platform.env.ts), [switches.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/platform/switches.ts), [setup plan](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/tools/setup/plan.mjs) | WEBHOOKS, REPORTS, USAGE, REALTIME default on; README introductory wording needed correction |
| Idempotency configuration | [platform.env.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/platform/platform.env.ts), [setup plan](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/tools/setup/plan.mjs) | Available deployment values required and optional; default required, not a universal on/off switch |
| Web client and navigation | [web package](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/web/package.json), [Vite config](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/web/vite.config.ts), [nav.ts](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/web/src/nav.ts) | React/Vite/TanStack Router verified; routes are generated and navigation is feature-contributed |
| Database and tenants | [tenant tables](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/core/tenancy/tenancy.tables.ts), [core module](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/core/core.module.ts) | Tenant-scoped database architecture found; no exhaustive cross-tenant security test in this audit |
| Development dependencies | [shared Compose](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/compose.yaml), [development Compose](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/compose.dev.yaml) | PostgreSQL, Redis, Mailpit, Floci and Gotenberg declared; startup health untested |
| AI API | [AI controller](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/apps/api/src/platform/ai/ai.controller.ts) | Asynchronous 202 workflow and tenant/provider constraints documented; external provider untested |
| CI and performance | [CI workflow](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/.github/workflows/ci.yml), [load test](https://github.com/lamberto15/nestjs-monorepo-template/blob/17bbde09d90540cbdd2bb91e47e1ec9a5bd60ae6/.github/workflows/load-test.yml) | Main CI is conditional by changed paths; load-test PR comparisons are explicitly report-only |

## Corrections arising from the audit

1. The earlier README suggested the first-run wizard leaves optional modules off. The wizard sets fresh defaults of `true` for WEBHOOKS, REPORTS, USAGE and REALTIME, matching `platform.env.ts`'s `on` defaults. The intro and evaluation FAQ have been corrected. These flags are separate from integrations that require configuration (such as AI and SMS).
2. IDEMPOTENCY is a deployment *mode* (`required` or `optional`, default `required`), not an on/off switch. Documentation must retain that distinction.
3. `notes` is a handcrafted demonstration feature; `pnpm feature:add` produces new feature scaffolding, so it is not correct to promise that copying `notes` gives generator output.
4. PR load-test numbers should not be described as an unconditional merge-blocking benchmark. The load-test workflow explicitly has a report-only PR path.

## Still to verify

- A clean Node/pnpm installation, wizard execution and developer quickstart on the exact branch.
- A generated feature round trip (add/sync/remove), complete migration and typed client regeneration.
- Every route, guard, tenant isolation path, web UI workflow, worker retry and permission edge case.
- Full PR checks, image builds and security scans on the final documentation commit.
- Live Compose, Swarm and Helm deployment, rollback under incompatible schemas, backup restore and a zero-downtime load test.
- Real providers for SSO, mail, object storage, SMS, push and AI.

These are **audit coverage gaps**, not claims that the features are broken. A static source review cannot establish production availability or security; follow the [release checklist](release-and-operations-checklist.md) and the [existing deep technical references](index.md).

## Keeping the findings current

Run `pnpm docs:check` and `pnpm docs:build` on documentation PRs. The first checks local links and a few implementation contracts, while the second builds the VitePress site. Neither replaces actual tests or human code review. See the [maintenance policy](../documentation-maintenance.md).
