# Contributing

Thanks for helping. This page is the short version; the full workflow is in
[docs/development.md](docs/development.md) ("Git workflow", "Issues and labels",
"Git hooks"), and the rules for the code are in [AGENTS.md](AGENTS.md) and
[docs/architecture.md](docs/architecture.md).

## Coding agents

All agents share [AGENTS.md](AGENTS.md). Claude Code loads it through the
`@AGENTS.md` import in [CLAUDE.md](CLAUDE.md), which also keeps Claude-only model
settings. Edit shared instructions in `AGENTS.md` to keep every agent in sync.
Rules for one part of the code live next to it (`apps/api/AGENTS.md`,
`apps/web/AGENTS.md`); a `CLAUDE.md` beside each imports it, so Claude loads
them only when it works in that folder.
For tools that do not discover this filename, configure their project context to
read `AGENTS.md`; for example, Gemini CLI supports
`{ "context": { "fileName": "AGENTS.md" } }` in `.gemini/settings.json`.

See the [AGENTS.md guide](https://agents.md/) and
[Claude Code memory documentation](https://code.claude.com/docs/en/memory).

## Setup

```bash
pnpm install        # also installs the git hooks (lefthook)
pnpm setup          # first run: writes apps/api/.env.development
pnpm services:up    # PostgreSQL, Redis, Mailpit and the rest, in Docker
pnpm dev            # the API on :3000 and the web app on :5173
```

Node.js 24 (`.nvmrc`, `engines` in `package.json`) and pnpm (`devEngines` in
`package.json`) are the versions the image and CI use. The devcontainer has both.

## Workflow

`main` is never edited directly. Every change goes through its own branch, worktree
and pull request:

1. **Claim an issue first.** Skip it if it is labelled `in progress`. Otherwise
   assign yourself, add the `in progress` label and comment the branch you will use.
2. **Branch in a worktree**, from the latest `main`:
   ```bash
   git fetch origin
   git worktree add --no-track -b <type>/<name> .claude/worktrees/<name> origin/main
   ```
   Push with `git push -u origin HEAD`.
3. **Commit with Conventional Commits**, `type(scope): subject` (types in
   `commitlint.config.js`). The commit-msg hook checks each commit; the pull request
   title is checked by CI.
4. **Open a draft pull request** early. Put `Closes #<n>` in its description so the
   issue closes on merge, and label it: an area (`frontend`, `backend`, `ci`,
   `documentation`) plus `enhancement` or `bug`. Fill in the
   [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
5. **Let CI run the check**: push early and fix failures with further commits;
   run a focused check locally only to investigate a CI failure. CI runs:
   ```bash
   pnpm build && pnpm lint && pnpm test && pnpm test:e2e   # e2e needs Docker
   pnpm db:check      # after changing a *.tables.ts
   pnpm client:check  # after changing a route
   ```
   Migrations come from `pnpm db:generate`, never by hand; the typed client from
   `pnpm client:generate`.
6. **Green CI, then squash-merge.** Remove the worktree first
   (`git worktree remove .claude/worktrees/<name>`), then squash-merge the pull
   request with its branch deleted.

Update a branch with `git fetch origin` and `git merge origin/main`. Do not rebase
or force-push a branch that is under review.

## Rules for the code

- Controllers do HTTP only; services own the logic and run it in one transaction
  with the audit entry ([architecture](docs/architecture.md), "Code style").
- Every feature follows [docs/adding-a-feature.md](docs/adding-a-feature.md) and starts
  from `pnpm feature:add`.
- The API is REST only, with Swagger UI at `/api` as its only page.
- Heavy or slow work goes to a queue worker, never into the request.
- Keep `env.example` complete when you add a variable.

## Releases

Template releases are `v*` tags pushed by the maintainer; their notes are generated
(see [docs/releases.md](docs/releases.md) and [CHANGELOG.md](CHANGELOG.md)). The typed
client's changes need a changeset: run `pnpm changeset` in your branch.

## Security and conduct

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Everyone
taking part follows the [code of conduct](CODE_OF_CONDUCT.md). The code is under the
[PolyForm Noncommercial 1.0.0 licence](LICENSE).
