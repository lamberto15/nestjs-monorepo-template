# Releases

Two things are released, each with its own version:

| What | Version | Who takes it | How |
| --- | --- | --- | --- |
| **The template** | `v*` tags on `main`, GitHub releases with notes; the images on GHCR by the same version | Projects built on it (they merge the tag: [upgrading](upgrading.md)) and deployments (`APP_IMAGE`) | The owner pushes a tag; CI publishes the images, then the release |
| **The typed client** (`packages/api-client`) | its `package.json` version and `CHANGELOG.md`, from [Changesets](https://changesets.dev) | Frontends, mobile apps and scripts that install it | Changesets in pull requests; a version pull request on `main`; publishing to npm is off until the owner turns it on |

## Template releases

### Versions

[Semantic versioning](https://semver.org) of the template as a whole, read
from an adopter's side:

- **major**: an update needs more than the merge: a contract step (a
  migration that drops or renames what an earlier release stopped using), a
  removed or renamed variable, a breaking change to the API (CI's
  OpenAPI diff in `check`), a new required service, a Node.js major;
- **minor**: features and modules, new optional variables;
- **patch**: fixes.

While the template has no adopters ([roadmap](roadmap.md), "Early stage"),
versions stay below 1.0: a minor release may break, and its notes say how.
1.0.0 goes with the first project built on the template, when `oasdiff` and
the migration lint become blocking.

A pre-release (`v1.3.0-rc.1`) is published the same way, as a GitHub
pre-release; its images get `1.3.0-rc.1` only.

### Cutting a release

From any checkout, once CI is green on `main`:

```bash
git fetch origin --tags
git tag -a v0.1.0 -m v0.1.0 origin/main     # an annotated tag on main's last commit
git push origin v0.1.0
```

- **CI on the tag** ([deployment](deployment.md), "CI") runs every check,
  publishes the images (`publish`, `publish-gotenberg`, `publish-caddy`: `0.1.0`, `0.1` and the
  commit's SHA), then `release` creates the GitHub release with its notes.
  A failing check stops it before anything is published.
- **The owner tags, by hand.** A tag pushed by a workflow (with
  `GITHUB_TOKEN`) would start no CI run, so nothing would be published.
- **A pushed tag never moves and is never deleted:** projects may have merged
  it, deployments may run its images. A bad release is followed by a fixed
  one.
- **The typed client first:** if its version pull request is open, merge it
  before tagging, so the release names the client's new version.

### The notes

`tools/release/notes.mjs` writes them from git, comparing the tag with the
release before it (the nearest `v*` tag among its ancestors, pre-releases
skipped for a final release), then appends GitHub's generated list of pull
requests:

| Section | From |
| --- | --- |
| Breaking changes | commits whose subject has `!` (`feat(iam)!: …`) or whose body has `BREAKING CHANGE:` |
| Upgrading | the merge, and [upgrading](upgrading.md) |
| Images | the app's, Gotenberg's and Caddy's tags and digests, as the publish jobs pushed them |
| Migrations | the files added under `apps/api/drizzle/` since the previous release, each linked; the expand/contract lint's findings (squawk, as CI's `migration-lint`); a merged migration edited or deleted, which drizzle never re-applies |
| Rolling back | the previous release's `APP_IMAGE`, `GOTENBERG_IMAGE` and `CADDY_IMAGE`; whether the previous release runs on this schema; the Compose files to check out with them |
| Configuration | variables added to or removed from `env.example` |
| Typed client | its version, when it changed, with a link to its changelog |

Locally (the tags fetched; the lint needs Docker, `--no-lint` skips it):

```bash
pnpm release:notes --tag v0.2.0 --repository lamberto15/nestjs-monorepo-template
node --test tools/release/notes.test.mjs     # its tests (CI's check job runs them)
```

Re-running the `release` job rewrites the notes of the existing release; edit
them on GitHub afterwards if needed (a later re-run overwrites the edit).

### Removing a deprecated route

A route marked `@Deprecated()` ([api-conventions](api-conventions.md),
"Deprecation") is removed only after its successor has been out for 6 months
and its sunset date has passed. Check `deprecated_route_calls_total{route}`
first: calls still arriving mean clients still depend on it. The release that
removes it lists it in the notes as a breaking change.

### Rolling back

Rolling back is rolling the image back: the previous release's images in
`.env`, then `docker compose pull` and `up` ([deployment](deployment.md),
"Publishing and rolling back images"). Migrations don't roll back, so the
previous release runs on the new schema. That holds only under the
expand/contract policy ([pitfalls](pitfalls.md), "Migrations:
expand/contract"): each release's notes say whether it kept to it, from the
same lint CI runs on pull requests, and name the Compose files to roll back
too.

## The typed client

`packages/api-client` is versioned on its own: its consumers care about its
types and calls, not about the template's other changes.
`.changeset/config.json` versions it even though it is private
(`privatePackages.version`), leaves the API out (`ignore`), and counts only
changes to its `src/`, `openapi.json` and `package.json`
(`changedFilePatterns`).

### A change to the client

A pull request that changes the client (a route change regenerates
`openapi.json` and `src/schema.ts`, so it does too) adds a changeset:

```bash
pnpm changeset            # pick the bump, describe the change for the client's users
```

Commit the new `.changeset/*.md` with the change.

- **The bump:** major for what breaks a consumer (a removed endpoint, field or
  enum value, a new required parameter: the OpenAPI diff in CI's `check` lists them),
  minor for additions, patch for fixes.
- `pnpm changeset --empty` records that a change needs no release (a
  refactor, a test).
- CI's `changeset` job (`.github/workflows/api-client.yml`) reports a client
  change without a changeset in its summary. Report-only, like the other
  checks while the template has no adopters; `CHANGESET_REQUIRED: on` in the
  workflow makes it blocking.

### The version pull request

On every push to `main` with changesets pending, the `version` job
(changesets/action) opens or updates one pull request,
`chore(api-client): release`, that consumes them: it raises the version and
writes `packages/api-client/CHANGELOG.md`. Merging it releases that version.

Owner actions it needs:

- **Allow GitHub Actions to create pull requests** (Settings, Actions,
  General, "Allow GitHub Actions to create and approve pull requests"; off
  today), or a token in the **`API_CLIENT_RELEASE_TOKEN`** secret instead (a
  fine-grained token for this repository with Contents and Pull requests
  read and write, or a GitHub App's token). Without either, the job fails
  when the first changeset reaches `main`, and says so.
- **CI on that pull request:** GitHub starts no workflow for a pull request
  opened with `GITHUB_TOKEN`, and `main`'s ruleset wants CodeQL's results
  before merging. Close and reopen the pull request (as a person) to run the
  checks; with `API_CLIENT_RELEASE_TOKEN` they run by themselves.

### Publishing the client

Off: the package is `"private": true`, and the `publish` job runs only when
the repository variable `API_CLIENT_PUBLISH` is `on`. Turning it on is the
owner's decision:

1. **The name.** `@nestjs-monorepo-template/api-client` needs the npm
   organization `nestjs-monorepo-template`; otherwise rename it to a scope
   you own (in `package.json` and wherever it is imported). Projects built on
   the template rename it to theirs.
2. **The package.** Remove `"private": true`, give it a license other than
   `UNLICENSED`, and a `repository` (`url`, `directory: packages/api-client`)
   matching this repository, which npm's provenance checks. `access` is
   `public` (`.changeset/config.json`).
3. **npm's trusted publishing** (no npm token in GitHub): on npmjs.com, the
   package's settings, Trusted publishing, GitHub Actions: this repository
   and the workflow `api-client.yml`. npm sets it up on an existing package,
   so the first version is published by hand (`npm login`, then `pnpm
   client:publish`).
4. **The variable:** Settings, Secrets and variables, Actions, Variables:
   `API_CLIENT_PUBLISH` = `on`.

Then, once a version pull request is merged, `publish` builds the client,
runs `changeset publish` (a version already on npm is skipped) and pushes
the tag `@nestjs-monorepo-template/api-client@<version>`. No GitHub release
per client version: the Releases page stays the template's, and the
client's notes are its changelog.

## Repository settings (owner)

- **Squash commits take the pull request's title.** Today the squash takes
  a single commit's subject, and the title only when there are several
  (`COMMIT_OR_PR_TITLE`), so `commit-messages.yml` checks both. With
  `PR_TITLE`, the title is the only subject `main` gets (Settings, General,
  Pull Requests, "Allow squash merging", default message "Pull request
  title", or `gh api -X PATCH repos/lamberto15/nestjs-monorepo-template -f
  squash_merge_commit_title=PR_TITLE -f
  squash_merge_commit_message=COMMIT_MESSAGES`). `main`'s subjects, which
  the release notes read for breaking changes, are then always the reviewed
  titles, and the single-commit check in `commit-messages.yml` can go.
- **Pull requests from Actions:** see [the version pull request](#the-version-pull-request).
- **Protect the release tags:** a tag ruleset on `refs/tags/v*` that blocks
  updates and deletions keeps a published release where it is.
