# Evaluate the template — nontechnical guide

**Audience:** product owners, team leads, project sponsors, evaluators and developers who have not yet chosen an architecture.

This section focuses on the choice to adopt the template: its purpose, trade-offs, obligations and likely fit. It deliberately avoids setup commands and implementation internals.

## Suggested reading order

1. [What it is (and is not)](what-it-is.md) — the product boundary and intended audience.
2. [Decision guide](decision-guide.md) — situations where it fits, situations where it does not, and an adoption scorecard.
3. [Capabilities and limits](capabilities-and-limits.md) — plain-English features and the work still required.
4. [Adoption and operations](adoption-and-operations.md) — people, infrastructure, security, licensing and ongoing costs.
5. [Frequently asked questions](faq.md) — practical answers before a team commits.

## In one paragraph

This is a customizable foundation for an organization-oriented web application. It provides common infrastructure such as accounts, permissions, tenant isolation, audit history, APIs, a React user interface, background jobs and deployment workflows, so an engineering team can focus on its own domain features. It is **not** a completed CRM, ERP, HRIS, store or SaaS offering. Organizations adopting it own their application's design, integration, hosting, compliance and support.

## Decision before implementation

If you only need a small internal form, a static website, or a standard SaaS tool, a more focused solution may be simpler. If you need a custom application with demanding access controls and long-term extensibility, this foundation may reduce recurring platform work — but it introduces operational complexity.

Ready to build? Use the separate [technical documentation](../technical/index.md). See [the actual license](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/LICENSE) before planning business use.
