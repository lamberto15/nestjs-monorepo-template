# Is this template right for your project?

## A quick fit check

| Situation | Fit | Why |
| --- | --- | --- |
| Custom multi-user web application with complex roles and an API | Strong candidate | Common platform functionality is already scaffolded |
| Multi-organization application needing isolated tenant data | Strong candidate, after review | Tenancy design is built in; isolation still needs application-specific testing |
| Internal workflow tool expected to grow over years | Possible fit | Saves repeated infrastructure work, but has a learning curve |
| Existing NestJS team wants consistent feature generation | Possible fit | Aligns conventions, migrations, client generation and tests |
| Simple landing page, static content or tiny CRUD prototype | Usually excessive | Too many moving parts for a narrow problem |
| Team without backend or operations expertise | Poor fit | Still requires engineers to deploy and maintain it |
| Turnkey industry system (ERP, HRIS, CRM, ecommerce) | Not by itself | Business-specific modules are not supplied |
| Organization needs commercial use with no separate license | Do not assume fit | The repository uses PolyForm Noncommercial licensing |
| Team needs strict API/backward compatibility from day one | Review carefully | The roadmap documents an early phase allowing breaking changes |

The labels above are decision aids, not certifications.

## Five questions before choosing it

1. **Do you need custom domain behavior?** If a product already covers your exact needs, compare buying it with building and maintaining your own.
2. **Can your team own the stack?** Plan for NestJS/TypeScript, React, PostgreSQL, Redis, container operations and security reviews.
3. **Do you need most of the platform capabilities?** Multiple tenants, permissions and queues are useful for some projects but overhead for others.
4. **Are you comfortable with the license and maturity?** Read [LICENSE](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/LICENSE), [releases](../releases.md) and [roadmap](../roadmap.md), and evaluate update risk.
5. **Can you validate the real workload?** Plan a proof of concept covering authentication, data isolation, a business feature, load, recovery and production deployment.

## A practical evaluation exercise

Ask an engineer to run the [quickstart](../technical/quickstart.md), remove the demo feature, generate one realistic business feature, write a permission rule, exercise a background job, deploy to a nonproduction environment and restore a backup. Assess how much was reusable, what required custom code and what your team could maintain.

Agree on **adoption criteria before the proof of concept**: required integrations, ownership, release cadence, access model, expected traffic, compliance obligations and operating budget.

## Choose alternatives when appropriate

- Use an existing SaaS product for commodity workflows when configuration covers the business need.
- Use a smaller NestJS or framework starter for a single-purpose API with no need for tenant-aware platform modules.
- Choose a managed backend when minimizing server operations is more important than owning a customized stack.

If adopting this template, proceed to [adoption and operations](adoption-and-operations.md) and then the [technical path](../technical/index.md).
