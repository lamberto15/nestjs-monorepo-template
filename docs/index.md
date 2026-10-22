# Documentation home

**Choose your path before diving into implementation details.** This repository is a template for building applications, not a hosted product or a turnkey business system.

| I want to… | Start here |
| --- | --- |
| Understand what the template does, with minimal jargon | [Nontechnical guide](nontechnical/index.md) |
| Decide whether it is right for my project | [Decision guide](nontechnical/decision-guide.md) |
| Understand capabilities, exclusions and licensing | [Capabilities and limits](nontechnical/capabilities-and-limits.md) |
| Evaluate hosting, maintenance and adoption effort | [Adoption and operations](nontechnical/adoption-and-operations.md) |
| Install and run it | [Technical quickstart](technical/quickstart.md) |
| Understand the repository and its data flows | [Technical system map](technical/system-map.md) |
| Build business-specific features | [Feature generator](adding-a-feature.md) |
| Deploy and operate safely | [Release and operations checklist](technical/release-and-operations-checklist.md) |
| Browse every engineering topic | [Technical documentation index](technical/index.md) |

## The two audiences

### Evaluators, decision makers and product owners

Read [what the template is](nontechnical/what-it-is.md), [the decision guide](nontechnical/decision-guide.md), [capabilities and limits](nontechnical/capabilities-and-limits.md), [adoption and operations](nontechnical/adoption-and-operations.md), then the [FAQ](nontechnical/faq.md). These explain *whether* to adopt it before telling you *how* to code.

### Developers, reviewers and operators

Read [technical quickstart](technical/quickstart.md), [system map](technical/system-map.md), and the [technical index](technical/index.md). The existing in-depth topic guides remain the authoritative reference; the new navigation pages do not replace them.

## Important boundaries

- The API is a NestJS REST service and Swagger UI, not a general-purpose HTML site. The repository also includes a separate React web application and typed API client.
- Some capabilities are configurable or require external services, credentials and operational work. Having code in a template does not mean a real deployment is production-ready without validation.
- **License:** [PolyForm Noncommercial 1.0.0](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/LICENSE). Check the license and obtain separate permission before assuming a commercial use is allowed.
- **Release maturity:** consult the [roadmap](roadmap.md), [releases](releases.md) and [GitHub release notes](https://github.com/lamberto15/nestjs-monorepo-template/releases) for the current state, including possible breaking changes.

## Website

This VitePress documentation is published independently on GitHub Pages after the repository's [one-time publishing setup](documentation-tooling.md#one-time-github-setting) is enabled and the workflow on `main` succeeds. It does not run within the production NestJS or React containers.

## About these docs

Documentation structure borrows the [Diátaxis](https://diataxis.fr/) distinction between learning, tasks, explanations and reference, while using audience-based entry points. For authoring conventions and how to keep documentation honest, see [documentation maintenance](documentation-maintenance.md); for the VitePress site and documentation checks, see [documentation tooling](documentation-tooling.md).
