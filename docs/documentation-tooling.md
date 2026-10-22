# Documentation tooling and VitePress

The **same Markdown in `docs/`** is the source for GitHub and a searchable VitePress documentation website. No duplicate copies of technical references are maintained.

## Local commands

With the repository's Node.js 24 and pnpm toolchain, run the following from the root:

```bash
pnpm docs:check     # check local links and selected source-code claims
pnpm docs:dev       # run the VitePress development server
pnpm docs:build     # build a static site at docs/.vitepress/dist
pnpm docs:preview   # preview its production output
```

The scripts use **VitePress 1.6.4**, pinned to the stable npm release when this was configured. They invoke `pnpm dlx vitepress@1.6.4` rather than changing the application's locked workspace dependencies. The first use downloads the tool; its **transitive dependencies are not locked** by this approach. If the site becomes release-critical or must build offline, add VitePress with pnpm, commit the regenerated `pnpm-lock.yaml`, and replace the `dlx` scripts in a focused follow-up PR.

The configuration is [`.vitepress/config.mjs`](https://github.com/lamberto15/nestjs-monorepo-template/blob/docs/audience-guides-20261022/docs/.vitepress/config.mjs). It defines nontechnical and technical navigation, in-browser **local search**, GitHub edit links and a nested reference sidebar.

## Build and publishing

A dedicated [documentation CI workflow](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/.github/workflows/docs.yml) runs the source/link checker and a site build when docs-related files change. It does **not** publish a site or change production application deployment.

The default VitePress base path is `/`. When publishing at a repository-scoped GitHub Pages URL, build with `DOCS_BASE=/nestjs-monorepo-template/`. For a custom domain use `/` or its real subpath. Publication needs a separately approved host, URL and permissions; avoid guessing that Pages is already enabled.

The [source audit](technical/implementation-audit.md) explains which architecture/capability claims were compared with code and which runtime tests remain outstanding. The checker is not a security audit or an external-URL crawler. VitePress validates its own rendered links during the build.

## Editorial standards and next enhancements

Use [Diátaxis](https://diataxis.fr/) within the separate [evaluation](nontechnical/index.md) and [engineering](technical/index.md) paths. Follow the [documentation maintenance policy](documentation-maintenance.md) to update reference docs in the same PR as a behavior change.

Consider [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) after agreeing on formatting rules, and [Lychee](https://github.com/lycheeverse/lychee) for scheduled external link checks. Add versioned documentation snapshots when public compatibility promises make historical docs worth maintaining.

Official references: [VitePress v1 documentation](https://vuejs.github.io/vitepress/v1/), [local search](https://vuejs.github.io/vitepress/v1/reference/default-theme-search), [deployment](https://vuejs.github.io/vitepress/v1/guide/deploy).
