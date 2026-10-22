# Documentation maintenance policy

## Audience and source of truth

- **Nontechnical pages** in `docs/nontechnical/` help people decide whether to adopt the template. Avoid code details unless necessary for a decision.
- **Technical navigation and task guides** in `docs/technical/` point to the deep technical references rather than repeating every implementation detail.
- **Topic reference guides** directly under `docs/` are the authoritative description of runtime behavior, configuration, security boundaries and extension contracts.
- The root [README](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/README.md) is a short public entry point plus overview; [docs/index.md](index.md) is the documentation hub.

## Write what is verified

When a behavior changes, inspect implementation/configuration/tests and update the corresponding reference in the **same pull request**. Do not use a roadmap item, third-party marketing description or an AI-generated claim as evidence that a feature works. Distinguish:

- Available in source from enabled by default;
- Supported configuration from tested production deployment;
- A pattern with safety controls from a compliance or availability guarantee;
- Current behavior from planned or experimental work.

Use links to the [roadmap](roadmap.md) and [releases](releases.md) for changeable statuses. Do not embed volatile test counts, third-party prices or current CI-green claims in evergreen guides.

## Maintain commands and links

Run `pnpm docs:check` to check local links and selected code assertions, and `pnpm docs:build` to validate the rendered VitePress site. These are drift alarms, not proof of runtime correctness. Review [the source audit](technical/implementation-audit.md) when implementation changes.


1. Run documented commands on a clean appropriate environment, or clearly mark them as unverified examples.
2. Check referenced files and relative links, especially when moving docs.
3. Record prerequisites, safety effects and whether commands modify files or databases.
4. Keep credentials, access tokens, secrets and identifiable customer data out of examples.
5. Update both paths if a change affects adoption decisions **and** engineering behavior.
6. Avoid adding new documentation frameworks or CI jobs in an unrelated feature PR; propose them in [tooling](documentation-tooling.md).

## Pull request reviewer checklist

- [ ] Does the change affect product capability, provider requirements, legal/operational expectations or UI? Update the relevant nontechnical page.
- [ ] Does it change an API, environment variable, feature declaration, database schema, job, CI rule, dependency or deployment? Update its deep technical reference.
- [ ] Does a new page have the right audience, an obvious task and working inbound/outbound links?
- [ ] Is any caution, required flag, provider credential or destructive effect explained?
- [ ] Are commands grounded in package scripts and links grounded in repository paths?
- [ ] Did the change avoid duplicating entire reference guides?

See [documentation tooling](documentation-tooling.md) for optional lint, link checks and future site generation.
