# Pulling template updates

A project built on this template keeps taking its updates: fixes, security
patches, new platform modules. The template publishes them as releases (`v*`
tags with notes, [releases](releases.md)); a project merges a release tag the
way it merges any branch. This is a git merge, not a generator: your changes
and the template's meet in the same files, and git keeps both.

## Starting a project so that updates merge

Clone the template, keeping its history, and make your own repository the
`origin`:

```bash
git clone https://github.com/lamberto15/nestjs-monorepo-template my-app
cd my-app
git remote rename origin template        # the template stays a remote
git remote add origin git@github.com:<you>/my-app.git
git push -u origin main
git push origin --tags                   # optional: the template's release tags
```

With the shared history, a later `git merge v1.4.0` brings exactly what the
template changed since the version you started from.

**A copy without the history** (a downloaded archive, a squashed first
commit, GitHub's "Use this template") shares no commit with the template, so
the first merge would conflict in every file. Record once which release you
started from, without changing any file:

```bash
git remote add template https://github.com/lamberto15/nestjs-monorepo-template
git fetch template --tags
git merge --allow-unrelated-histories -s ours v1.2.0 -m "chore: record template v1.2.0 as merged"
```

`-s ours` keeps your tree as it is and tells git that v1.2.0 is in it; from
then on, merges bring only what changed after v1.2.0. Pick the release you
copied (by date: `git for-each-ref --sort=creatordate
--format='%(creatordate:short) %(refname:short)' 'refs/tags/v*'`); if you
started between two releases, record the commit you copied instead of a tag.

## Taking a release

Read the release's notes first ([the Releases page](https://github.com/lamberto15/nestjs-monorepo-template/releases)):
its breaking changes, its migrations (and whether the release before it runs
on them), new variables, the typed client's version. Then, in your project,
the usual way (a branch, a pull request, CI; [development](development.md),
"Git workflow"):

```bash
git fetch template --tags
git switch -c chore/template-v1.3.0 origin/main
git merge --no-edit v1.3.0                # always a merge commit: "Merge tag 'v1.3.0'"
# resolve the conflicts (below), then:
pnpm install
pnpm build && pnpm lint && pnpm test && pnpm test:e2e
pnpm db:check && pnpm client:check
git push -u origin HEAD                   # a pull request, CI, review
```

- **One release at a time** when a release's notes list destructive
  statements (a contract step: dropping what an earlier release stopped
  using). Expand/contract assumes the expand release was deployed before the
  contract one ([pitfalls](pitfalls.md), "Migrations: expand/contract"); a
  rollback goes back one release only. Releases without them can be merged
  several at once (merge the newest tag).
- **Merge, don't rebase or cherry-pick:** the merge records which release you
  have, so the next one brings only its own changes.
- **What changed in a file:** `git log v1.2.0..v1.3.0 -- <path>` and
  `git diff v1.2.0 v1.3.0 -- <path>`.
- **Remember resolutions:** `git config rerere.enabled true` replays a
  conflict's resolution when the same conflict comes back (a file you
  changed the same way every time).
- The commit-msg hook lets merge commits through; your pull request's title
  is checked as usual (`chore: template v1.3.0`).

## Conflicts

| Where | What to do |
| --- | --- |
| `apps/api/drizzle/` | Read [the migrations](#the-migrations) below: never hand-merge the journal |
| `pnpm-lock.yaml` | Take either side, then `pnpm install` regenerates it: `git checkout --theirs pnpm-lock.yaml && pnpm install` |
| `packages/api-client/openapi.json`, `src/schema.ts` | Generated: resolve the routes first, then `pnpm client:generate` |
| `packages/api-client/package.json` (version), `CHANGELOG.md` | Your client's version and changelog are your own once you publish it: keep yours (`git checkout --ours`). The template's pending changesets (`.changeset/*.md`) describe changes you now have too: keep them for your next version, or delete them |
| `docs/roadmap.md`, `README.md`, `CLAUDE.md` | Yours: keep your side, take what you want of the template's |
| `env.example`, `docs/configuration.md` | Keep both sides' variables; the release notes list the new ones |
| `app.module.ts`, `schema.ts`, feature registrations | Keep both: your features and the template's modules sit side by side |
| `compose*.yaml`, `.github/workflows/` | Take the template's unless you changed them, then merge by hand; CI checks Compose's secrets and images |

A file you deleted and the template changed comes back as a conflict
(`deleted by us`): `git rm <file>` keeps it deleted.

### The migrations

drizzle's migrator applies, in the journal's order, the migrations newer than
the last one a database applied, and skips the older ones
([pitfalls](pitfalls.md), "Migrations: expand/contract"). The template's
migrations were generated before you merged them, so:

- **No migrations of your own since your last template merge:** the
  template's merge cleanly (new files, journal entries appended) and apply in
  order. Keep them.
- **Migrations of your own since then:** both sides appended to
  `meta/_journal.json` and numbered their files from the same index. Don't
  merge them: the template's entries would come before yours in time, and a
  database that applied yours would skip them silently. Take your side of
  the folder, then generate the template's schema changes as a migration of
  your own (its `*.tables.ts` changes came with the merge):

  ```bash
  git restore --source=HEAD --staged --worktree -- apps/api/drizzle   # your migrations only
  pnpm db:generate                                                    # one new migration: the template's changes
  pnpm db:check
  git add apps/api/drizzle && git commit                              # concludes the merge
  ```

  The migration is generated, as every migration is, and CI's
  `migration-lint` checks it like any other. It holds the same statements as
  the template's, so the release notes' expand/contract findings apply to it.
- **Never edit a migration you already deployed**, theirs or yours: change
  the tables and generate a new one.

## Deploying the update

As any release of your project ([deployment](deployment.md)): the migrations
run first, while the previous release still serves. Check the release notes'
"Rolling back" section before deploying: rolling back is rolling the image
back, and works only while every migration in between follows expand/contract.
