# AGENTS.md

A **NestJS 12 REST backend template**: the starting point for new projects.
A pnpm + Turborepo monorepo: the API in `apps/api`, the typed client in
`packages/api-client`, the web app in `apps/web` (components in
`packages/ui`). Commands run from the root; `pnpm dev` runs the API and the
web app (<http://localhost:5173>).

<!--
Maintainers: this file is the source of truth for every coding agent.
CLAUDE.md imports it and holds only Claude-specific settings; agents that
don't discover AGENTS.md must be configured to read it (CONTRIBUTING.md).
Folder rules live in apps/api/AGENTS.md and apps/web/AGENTS.md, each with a
CLAUDE.md that imports it, so they load only when an agent works there.
Keep this file short: every line here is paid for in every session.
Test counts are not kept here: every pull request changed them.
-->

**Before changing code in a folder, read its rules:** `apps/api` (and its
migrations): [apps/api/AGENTS.md](apps/api/AGENTS.md); `apps/web` and
`packages/ui`: [apps/web/AGENTS.md](apps/web/AGENTS.md).

## How to work

- **Follow the code that's there.** Find the closest existing example (a
  feature, a test, a component) and match its shape. Look up a library's
  docs only for an API this repo doesn't use yet, or when unsure; then use
  the documented way rather than rebuilding what the library offers.
  Sources: Context7 (`resolve-library-id`, then `query-docs`) when available,
  else the official docs; for NestJS, docs.nestjs.com and the installed
  `@nestjs/*` packages. Custom code only when nothing fits, with a comment
  saying why.
- **Smallest change that does the task.** No new layer, base class,
  interface, generic helper, option or flag until a second real caller needs
  it; a few similar lines beat a premature abstraction. Leave code the task
  doesn't touch as it is; file an issue for what you notice there.
- **NestJS layering, nothing more:** a controller does HTTP only, a service
  owns the logic and its queries, a module wires them
  ([apps/api/AGENTS.md](apps/api/AGENTS.md), "Layers").
- **Tests prove the change, nothing else.** Add or update tests for the
  behavior you changed, in the existing test file for it; a fix gets one test
  that fails without it. No tests for code you didn't touch, for the
  framework or for generated code, and no "just in case" suites.
- **Spend tokens like money.** Search before reading; read the section you
  need, not the whole file; open only the doc the task needs (Map below).
  Don't run the full suite locally: CI runs it. Keep replies, commit messages
  and PR descriptions short.

## Owner's rules (always apply)

- **Never edit `main`: every change goes through a worktree.** Each change
  gets a branch in its own worktree (`.claude/worktrees/<name>`), a pull
  request to `origin` (GitHub) and green CI; then the worktree is removed and
  the PR squash-merged with its branch deleted. Never rebase or force-push:
  update a branch with `git merge origin/main`. See docs/development.md, "Git workflow".
- **Open a draft PR early and use CI for validation.** Push the first
  reviewable commit and open its draft PR while work continues; push
  incremental commits so CI runs during implementation. Run focused local
  checks only to investigate a CI failure or when the owner asks. Keep the PR
  draft until ready for review; merge only on green CI.
- **Verify every PR check before reporting success.** Inspect the complete
  check-run list and review comments, including external quality gates such
  as SonarQube Cloud; passing GitHub Actions workflows alone is not enough.
- **Label every pull request, and claim the issue you work.** Label a PR by
  what it changes: `frontend` (apps/web, packages/ui), `backend` (apps/api, the
  client's generation, migrations), `ci` (workflows, images, deploys),
  `documentation` (docs only), plus `enhancement` or `bug`. Check
  `gh label list` and add a missing label with `gh label create`. To work an
  issue, skip it if it's already `in progress`; otherwise claim it first:
  `gh issue edit <n> --add-assignee @me --add-label "in progress"`, and comment
  the branch (sessions share one account). Put `Closes #<n>` in the PR
  description. Found a problem on the other side while focused on one? File
  it as an issue with that side's label rather than fixing it there. See
  docs/development.md, "Issues and labels".
- **No raw SQL in the API.** Drizzle's query builder for every query; `sql`
  only for an expression it lacks. The owner's rule, enforced by
  `tools/ci/raw-sql.mjs` ([apps/api/AGENTS.md](apps/api/AGENTS.md),
  "Features and the database").
- **Generate, never hand-write what a command produces** (extensions:
  docs/development.md, "Database"). Use the official
  CLI or generator, then edit only what the task needs: `pnpm add`,
  `pnpm feature:add`/`feature:sync`, `pnpm db:generate`,
  `pnpm client:generate`, and the folders' own generators (their AGENTS.md).
- **Features come from the generator.** A new one starts from
  `pnpm feature:add` (the `/add-feature` skill in `.claude/skills/`), never
  from copying `notes`; then write only the business logic, where the
  generated service says so.
- **Newest versions, pinned** (never `:latest`); Dependabot proposes updates.
- `.env*` files must not be written directly by agents: the owner copies the template
  (`pnpm setup` writes them, or `cp env.example .env` at the root and fills it, or `cp
  apps/api/env.development.example apps/api/.env.development`). Keep
  `env.example` complete when adding variables.

## Map

Everything is in `docs/`; a name below is its file (`tags` is
`docs/tags.md`). Read the one the task needs.

- **Start here:** `architecture` (where things are, layers, processes),
  `monorepo` (root scripts, Turborepo, the web app), `development` (setup,
  commands, tests, migrations, demo seed, devcontainer, git workflow and
  hooks, browser and load tests, typed client), `pitfalls` (mistakes already
  made), `roadmap`.
- **Features:** `adding-a-feature` (`pnpm feature:add`; changing one: edit
  its `<item>.record.ts`, then `pnpm feature:sync`), `api-conventions`
  (versions, errors, pagination, filters, credentials).
- **Access:** `identity` (account vs membership vs unit membership vs employee; onboarding modes; offboarding), `auth` (sign-in, tokens, passkeys, SSO, SCIM, API clients,
  impersonation, Turnstile, data export, account deletion, "Locked out"),
  `permissions` (roles, grants, organizational units, audit), `tenancy` (RLS, operators,
  break-glass, `TENANCY=single`), `encryption`, `retention` (and legal holds).
- **Background and integrations:** `background-work` (queues, mail, outbox,
  workflows, cron), `webhooks-and-realtime`, `notifications`,
  `deliverability`, `ai`, `documents` (PDFs).
- **Record add-ons:** `tags`, `comments`, `attachments` (and avatars),
  `revisions`, `approvals`, `saved-views`, `favorites`, `work-surfaces` (inbox,
  recent records, presence), `custom-fields`,
  `bulk-operations`, `sequences` (numbers, naming series), `data-transfer`
  (exports, imports), `import-limits`, `reports`.
- **Configuration:** `configuration` (environment variables), `settings`
  (and feature flags), `branding`, `i18n-and-time`, `money`, `usage`
  (quotas), `build-version`.
- **Deploy and operate:** `deployment` (Compose, CI and its scans, images,
  the operator CLI `pnpm ops`, log redaction, metrics, alerts,
  zero-downtime overview), `deploy-rolling`, `deploy-blue-green`,
  `deploy-swarm`, `deploy-k3s`, `deploy-kubernetes`, `ci-runtime`,
  `releases`, `upgrading`.
- **This docs site:** `documentation-tooling`, `documentation-maintenance`.

## Validation in CI

These are the required CI checks, not a local gate before every commit.

```bash
pnpm build && pnpm lint && pnpm test && pnpm test:e2e   # e2e starts redis-server and PostgreSQL (Docker)
pnpm db:check                                           # after table changes
pnpm test:e2e:web                                       # after web changes: Playwright (CI's e2e-web)
pnpm client:check                                       # after route changes (pnpm client:generate fixes it)
```

`pnpm lint` ends with knip (unused files, exports, dependencies; `knip.jsonc`),
and CI enforces coverage thresholds per package (`vitest.config.ts`; ratchet
them up, never down): docs/development.md, "Coverage" and "Dead code (knip)".

## Pitfalls

- Python/sed edits must fail loudly when a match misses (Prettier reformats code).
- Shell: do not assume aliases such as `grep` → ripgrep or `ls` → eza exist.
  Claude hooks refuse `/dev/null` redirects and recursive deletes of system paths,
  even in heredocs.

## Deployment data

Keep live hostnames, addresses, account identifiers, and production topology out
of this public template. Put deployment-specific settings in protected CI
environment variables and credentials in the platform's secret store. Consult
the deployment runbook for your own environment before changing production data.
