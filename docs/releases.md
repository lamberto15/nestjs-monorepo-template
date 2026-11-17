# Releases

One thing is released: **the template**, as `v*` tags on `main` with GitHub
releases and their changelog. Projects built on it merge the tag
([upgrading](upgrading.md)). Release Please keeps a release pull request
open; merging it tags and publishes the release. No image is published: a
project builds and deploys its own. The typed
client (`packages/api-client`) has no release of its own
([The typed client](#the-typed-client)).

## Template releases

### Versions

[Semantic versioning](https://semver.org) of the template as a whole, read
from an adopter's side:

- **major**: an update needs more than the merge: a contract step (a
  migration that drops or renames what an earlier release stopped using), a
  removed or renamed variable, a breaking change to the API, a new required service, a Node.js major;
- **minor**: features and modules, new optional variables;
- **patch**: fixes.

While the template has no adopters ([roadmap](roadmap.md), "Early stage"),
versions stay below 1.0: a minor release may break, and its notes say how.
1.0.0 goes with the first project built on the template, when the migration
lint becomes blocking.

Release Please computes the next version from the Conventional Commit titles
merged since the last release (`fix:` → patch, `feat:` → minor, `!` or
`BREAKING CHANGE:` → minor while below 1.0, major after).

A pre-release (`v1.3.0-rc.1`) comes from a `Release-As: 1.3.0-rc.1` footer in
a pull request's description (the squash commit's body): the release pull
request then proposes that version. It is published as a GitHub pre-release.

### How a release is made

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
2. **Release Please tags** the merge commit `vX.Y.Z` and publishes the
   GitHub release with the changelog entry.
3. **CI runs on that commit** and has nothing to test: the release changes
   only `CHANGELOG.md`, `.release-please-manifest.json` and the root
   `package.json`'s version, which `main` already validated.

- **The built-in token only:** no personal token or GitHub App.
- **A tag never moves and is never deleted:** projects may have merged it. A
  bad release is followed by a fixed one.

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

Rolling back is deploying the previous release again: its images in `.env`
(`APP_IMAGE`, `CADDY_IMAGE`), then `docker compose pull` and `up`, on a
Compose host. Migrations don't roll back, so the previous release runs on the
new schema. That holds only under the expand/contract policy
([pitfalls](pitfalls.md), "Migrations: expand/contract"), which the migration
lint checks on pull requests; roll the Compose files back with the images.

## The typed client

`packages/api-client` is a private workspace package: the web app takes it
from the workspace, and it ships with the template's releases. It has no
version, changelog or release flow of its own (Changesets was removed in
#1100: a second release system for a package nobody installs from npm), and
the `version` in its `package.json` is not maintained. A change to the client
is named in the template's notes like any other, from its pull request's
title; what breaks a consumer (a removed endpoint, field or enum value, a new
required parameter) takes `!` or a `BREAKING CHANGE:` footer.

A project that offers its client on npm adds its own release for it: remove
`"private": true`, give the package a scope you own and a `repository`, and
use npm's trusted publishing from a workflow of your own.

## Repository settings (owner)

- **Squash commits take the pull request's title** (`PR_TITLE`, with the
  description as the body, `PR_BODY`: Settings, General, Pull Requests, "Allow
  squash merging"). `main`'s subjects, which Release Please reads for the
  version and the changelog, are always the reviewed titles, and the single-commit check in
  `commit-messages.yml` can go.
- **Pull requests from Actions:** on, for both release pull requests (the
  template's and [the client's](#the-version-pull-request)).
- **Protect the release tags:** a tag ruleset on `refs/tags/v*` that blocks
  updates and deletions keeps a published release where it is.
