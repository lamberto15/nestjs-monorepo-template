# Documentation tooling: recommendation and rollout

**Decision:** keep Markdown in this repository as the canonical documentation source. Improve navigation and accuracy first; only then add a documentation site or additional dependencies. This page is a proposal, not an assertion that the listed tools are installed.

## Recommended approach

| Need | Recommended option | Why / trade-off |
| --- | --- | --- |
| Separate audiences while keeping source docs | These `docs/nontechnical/` and `docs/technical/` guides, alongside the existing references | No migration, no dependency updates; works directly on GitHub |
| Reliable content structure | [Diátaxis](https://diataxis.fr/) | Distinguishes tutorials, how-to guides, explanations and reference within each audience |
| Public searchable documentation site | [VitePress](https://vitepress.dev/guide/what-is-vitepress) | Markdown-first, lightweight static docs, suitable for this JavaScript/TypeScript workspace |
| Browser-based local search | [VitePress local search](https://vitepress.dev/reference/default-theme-search) | Built-in search without a hosted search service |
| Markdown consistency | [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) | Can run locally and in CI; choose rules incrementally to avoid mass noise |
| Broken link checks | [lychee](https://github.com/lycheeverse/lychee) | Checks internal/external links in Markdown; external sites can be flaky or rate limited |
| Strong docs release versioning and i18n later | [Docusaurus](https://docusaurus.io/docs) | More features but added framework and maintenance overhead |
| Alternative Python-based docs tooling | [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/setup/) | Mature navigation/search, but introduces a separate Python toolchain |

## Why not generate a website in this PR?

The repository already maintains extensive Markdown technical guides, and the first gap is **discoverability**, not rendering. A website introduces package-lock and CI changes, routing, hosting permissions and link-conversion decisions. It should be a separate reviewed change after the content hierarchy settles.

## Suggested incremental rollout

1. **Now:** two audience entry points, explicit licensing/maturity limits, links to existing deep references, and a documentation-maintenance checklist.
2. **Next PR:** add lightweight internal-link checking and changed-file Markdown linting; pin all action versions or SHAs according to repository policy. Audit existing links before making checks blocking.
3. **Optional site PR:** install VitePress as a workspace dependency, add navigation/sidebar grouping the two audiences, local search, edit links and a clear site base path; make the docs build a CI check.
4. **Optional publication PR:** deploy the generated static site to GitHub Pages or another approved static host. Keep the source Markdown and GitHub README accessible even without the site.
5. **Only when needed:** snapshot versioned docs for breaking releases and add i18n. Versioning every early iteration increases maintenance cost.

## How to measure success

Ask a first-time evaluator to answer "Is this for me?", "May I use it commercially?" and "What will I operate?" in a few minutes. Ask a contributor to locate the source of truth for a feature, an environment variable, a schema change and a rollback. Track broken internal links and outdated commands, not page count.

References: [VitePress deployment](https://vitepress.dev/guide/deploy), [Docusaurus versioning guidance](https://docusaurus.io/docs/versioning) and [Diátaxis](https://diataxis.fr/).
