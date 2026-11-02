# Releases

Two things are released, each with its own version:

| What                                         | Version                                                                                  | Who takes it                                                                                                                 | How                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **The template**                             | `v*` tags on `main`, GitHub releases with notes; the images on GHCR by the same version  | Projects built on it (they merge the tag: [upgrading](upgrading.md)) and our environments (production deploys only releases) | Release Please keeps a release pull request open; merging it tags the release, and `release.yml` promotes the images CI already built |
| **The typed client** (`packages/api-client`) | its `package.json` version and `CHANGELOG.md`, from [Changesets](https://changesets.dev) | Frontends, mobile apps and scripts that install it                                                                           | Changesets in pull requests; a version pull request on `main`; publishing to npm is off until the owner turns it on                   |

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

Release Please computes the next version from the Conventional Commit titles
merged since the last release (`fix:` → patch, `feat:` → minor, `!` or
`BREAKING CHANGE:` → minor while below 1.0, major after).

A pre-release (`v1.3.0-rc.1`) comes from a `Release-As: 1.3.0-rc.1` footer in
a pull request's description (the squash commit's body): the release pull
request then proposes that version. It is published as a GitHub pre-release;
staging can deploy it, production refuses it.

### How a release is made

Numbering restarted on 2026-11-02 with this process: the first release it
makes is `v0.1.0` (`initial-version`), and the earlier hand-made `v0.1.0`
was removed (its images were not under this repository's owner).

Nobody tags by hand. Release Please (`.github/workflows/release-please.yml`,
`release-please-config.json`, the last version in
`.release-please-manifest.json`) runs on every push to `main` and keeps one
pull request open, `chore(main): release x.y.z`, with the next version in
`package.json` and its `CHANGELOG.md` entry.

1. **Merge the release pull request** when `main` holds what should ship.
   That merge is the only decision. It needs its CI, like any pull request:
   GitHub starts no workflow for a pull request made with the built-in token,
   so select **Approve workflows to run** on it if GitHub offers it, or close
   and reopen it (as a person). `main`'s ruleset then wants one approval for
   a bot-made change.
2. **Release Please tags** the merge commit `vX.Y.Z` and leaves a **draft**
   GitHub release with the changelog entry.
3. **CI / CD runs on that commit** (it changed `package.json`): every check,
   then it builds, scans, signs and publishes the images, as for any merge.
4. **`release.yml` promotes the tag** once CI / CD passed there. It never
   builds: it checks that commit's release manifest and images as a deploy
   does (run evidence, ancestry, signatures, attestations), tags the images
   `X.Y.Z` (the same digests), writes the notes, attaches
   `release-manifest.json` and publishes the release (a pre-release for a
   `-rc` version). It then starts the Lighthouse report on the tag.
5. **Deploy** ([deploy-swarm](deploy-swarm.md)): staging already runs that
   commit's images; production takes the tag by a manual Deploy run, which
   refuses drafts and pre-releases.

- **Retry:** if a promotion failed (a check, the registry), fix the cause and
  run Actions, Release, Run workflow with the tag. A tag pushed by hand on a
  commit of `main` is promoted the same way.
- **The built-in token only:** no personal token or GitHub App. What it makes
  starts no workflow, which is why `release.yml` follows CI / CD
  (`workflow_run`) instead of the tag, and why the release pull request's CI
  needs the click above.
- **A tag never moves and is never deleted:** projects may have merged it,
  deployments may run its images. A bad release is followed by a fixed one.
- **The typed client first:** if its version pull request is open, merge it
  before the release pull request, so the release names the client's new
  version.

### Production takes releases only

Production is deployed by hand (Actions, Deploy, `production`, the tag) and
the environment's required reviewer approves the run. The workflow refuses a
tag whose GitHub release is a draft (not promoted yet) or a pre-release, and
deploys the digests its `release-manifest.json` names, checked again. A
release whose CI artifact has expired (90 days) can no longer be deployed:
take a newer one.

### The notes

`tools/release/notes.mjs` writes them from git, comparing the tag with the
release before it (the nearest `v*` tag among its ancestors, pre-releases
skipped for a final release), then appends the changelog entry Release Please wrote (for a tag pushed by
hand, GitHub's generated list of pull requests):

| Section          | From                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking changes | commits whose subject has `!` (`feat(iam)!: …`) or whose body has `BREAKING CHANGE:`                                                                                                                                            |
| Upgrading        | the merge, and [upgrading](upgrading.md)                                                                                                                                                                                        |
| Images           | the app's, Gotenberg's and Caddy's version tags and digests, as `release.yml` tagged them                                                                                                                                       |
| Migrations       | the files added under `apps/api/drizzle/` since the previous release, each linked; the expand/contract lint's findings (squawk, as CI's `migration-lint`); a merged migration edited or deleted, which drizzle never re-applies |
| Rolling back     | the previous release's `APP_IMAGE`, `GOTENBERG_IMAGE` and `CADDY_IMAGE`; whether the previous release runs on this schema; the Compose files to check out with them                                                             |
| Configuration    | variables added to or removed from `env.example`                                                                                                                                                                                |
| Typed client     | its version, when it changed, with a link to its changelog                                                                                                                                                                      |

Locally (the tags fetched; the lint needs Docker, `--no-lint` skips it):

```bash
pnpm release:notes --tag v0.2.0 --repository lamby-dev/nestjs-monorepo-template
node --test tools/release/notes.test.mjs     # its tests (CI's check job runs them)
```

Running `release.yml` again for the tag rewrites the notes; edit them on
GitHub afterwards if needed (a later run overwrites the edit).

### Removing a deprecated route

A route marked `@Deprecated()` ([api-conventions](api-conventions.md),
"Deprecation") is removed only after its successor has been out for 6 months
and its sunset date has passed. Check `deprecated_route_calls_total{route}`
first: calls still arriving mean clients still depend on it. The release that
removes it lists it in the notes as a breaking change.

### Upgrading across a removed rename

Names that rows store (a role's condition key, a settings scope, an approval
rule's type) are rewritten at migrate by `apps/api/src/stored-renames.ts`;
a release that drops an entry says so in its notes. The team-era renames
(org units → teams → organizational units, #595) are gone, and so is the
saved-views `team` visibility. A database must pass through the
organizational-units release first, migrate included. A release without
the renames fails its migrate when a row still holds `manageTeams`,
`manageOrgUnits`, `inMyTeams`, a settings scope or view visibility `team` or
`orgUnit`, a view scope `team:<id>`, `teamRole`, `orgUnitRole` or `team-lead`
(`RETIRED_NAMES` in the same file), naming the tenant and column. Nothing is
rewritten or deleted by the failure: migrate with the earlier release, then
this one.

### Rolling back

Rolling back is deploying the previous release again: a Deploy run with its
tag on our environments ([deploy-swarm](deploy-swarm.md), "Rolling back"), or
its images in `.env`, then `docker compose pull` and `up`, on a plain Compose
host ([deployment](deployment.md), "Publishing and rolling back images"). Migrations don't roll back, so the
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
  General, "Allow GitHub Actions to create and approve pull requests"; on
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
2. **The package.** Remove `"private": true`, check its license (`package.json`
   says `PolyForm-Noncommercial-1.0.0` today) is the one you want to publish
   under, and give it a `repository` (`url`, `directory: packages/api-client`)
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

- **Squash commits take the pull request's title** (`PR_TITLE`, with the
  description as the body, `PR_BODY`: Settings, General, Pull Requests, "Allow
  squash merging"). `main`'s subjects, which the release notes read for breaking
  changes, are always the reviewed titles, and the single-commit check in
  `commit-messages.yml` can go.
- **Pull requests from Actions:** on, for both release pull requests (the
  template's and [the client's](#the-version-pull-request)).
- **Protect the release tags:** a tag ruleset on `refs/tags/v*` that blocks
  updates and deletions keeps a published release where it is.
