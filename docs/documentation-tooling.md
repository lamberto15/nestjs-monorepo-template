# Documentation tooling and VitePress

The **same Markdown in `docs/`** is the source for GitHub and a searchable VitePress documentation website. No duplicate copies of technical references are maintained.

## Local commands

With the repository's Node.js 26 and pnpm toolchain, run the following from the root:

```bash
pnpm docs:check     # check local links and selected source-code claims
pnpm docs:dev       # run the VitePress development server
pnpm docs:build     # build a static site at docs/.vitepress/dist
pnpm docs:preview   # preview its production output
```

The scripts use **VitePress 1.6.4**, pinned to the stable npm release when this was configured. They invoke `pnpm dlx vitepress@1.6.4` rather than changing the application's locked workspace dependencies. The first use downloads the tool; its **transitive dependencies are not locked** by this approach. If the site becomes release-critical or must build offline, add VitePress with pnpm, commit the regenerated `pnpm-lock.yaml`, and replace the `dlx` scripts in a focused follow-up PR.

The configuration is [`.vitepress/config.mjs`](https://github.com/lamberto15/nestjs-monorepo-template/blob/docs/audience-guides-20261022/docs/.vitepress/config.mjs). It defines nontechnical and technical navigation, in-browser **local search**, GitHub edit links and a nested reference sidebar.

## GitHub Pages publishing

The [Documentation workflow](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/.github/workflows/docs.yml) validates docs on pull requests and **publishes only after a docs-related change is merged into `main`** (or when manually dispatched from `main`). The PR build uses the same base path as production, but PRs cannot upload or publish Pages artifacts.

The public URL, **once publishing is enabled and succeeds**, is:

**https://lamberto15.github.io/nestjs-monorepo-template/**

The workflow builds with `DOCS_BASE=/nestjs-monorepo-template/`, uploads only `docs/.vitepress/dist` and deploys through GitHub's artifact-based Pages integration. It does not publish the source tree, involve the NestJS/React production containers or require additional stored credentials.

### One-time GitHub setting

GitHub Pages needs a repository administrator to select its publishing source:

1. Go to [Repository settings → Pages](https://github.com/lamberto15/nestjs-monorepo-template/settings/pages).
2. Under **Build and deployment → Source**, select **GitHub Actions** (not `Deploy from a branch`).
3. Merge the reviewed documentation PR to `main`. The Documentation workflow will then build and deploy. If the setting was enabled *after* merging, open [Actions → Documentation](https://github.com/lamberto15/nestjs-monorepo-template/actions/workflows/docs.yml) and use **Run workflow** on `main`.
4. Check that the **Publish documentation to GitHub Pages** job succeeded and open the published URL. GitHub can require a short delay for the first site to become visible.

Recommended: under [Settings → Environments](https://github.com/lamberto15/nestjs-monorepo-template/settings/environments), restrict the `github-pages` environment to deployments from `main`. The workflow itself already enforces this; the environment rule supplies defense in depth.

### Security and maintenance

The build job only has `contents: read`; the publishing job alone has `pages: write` and `id-token: write` (plus `actions: read` to access the artifact). All GitHub Pages actions are pinned to commit SHAs. **No pull request can deploy the documentation.**

The site is **public**: do not put secrets, private endpoints or internal-only runbooks into the Markdown. If a custom domain is added later, change the VitePress base to `/` when hosting at the domain root and configure DNS and Pages' custom-domain settings separately. Leave the current repository base for the default `github.io` project site.

If the deployment fails with `Not Found`, `Pages site not enabled`, or environment authorization errors, check GitHub Pages Source and environment restrictions first, then inspect the Documentation workflow's deploy job. A passing build alone does not mean the site is published. The static site is not served by your production API, web app or Docker Compose stack.

The [source audit](technical/implementation-audit.md) explains which architecture/capability claims were compared with code and which runtime tests remain outstanding. The checker is not a security audit or an external-URL crawler; VitePress validates its rendered links during the build.

## Editorial standards and next enhancements

Use [Diátaxis](https://diataxis.fr/) within the separate [evaluation](nontechnical/index.md) and [engineering](technical/index.md) paths. Follow the [documentation maintenance policy](documentation-maintenance.md) to update reference docs in the same PR as a behavior change.

Consider [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) after agreeing on formatting rules, and [Lychee](https://github.com/lycheeverse/lychee) for scheduled external link checks. Add versioned documentation snapshots when public compatibility promises make historical docs worth maintaining.

Official references: [VitePress v1 documentation](https://vuejs.github.io/vitepress/v1/), [local search](https://vuejs.github.io/vitepress/v1/reference/default-theme-search), [deployment](https://vuejs.github.io/vitepress/v1/guide/deploy).
