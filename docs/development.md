# Development

```bash
pnpm install
pnpm services:up          # PostgreSQL 18, Redis 8, Mailpit, Floci (project <name>-dev)
cp apps/api/env.development.example apps/api/.env.development   # points the app at them
pnpm start:dev            # the API and the workers, with reload: http://localhost:3000/api
```

Every command runs from the repository root. The API lives in `apps/api`
([architecture](architecture.md)); the root's scripts run its tasks there,
through Turborepo or `pnpm --filter` ([monorepo](monorepo.md)).

- **PostgreSQL and Redis are required**, in development as in production:
  `pnpm services:up` runs them (`DATABASE_URL`, `DATABASE_OWNER_URL` and
  `REDIS_URL` come from `apps/api/.env.development`). Without a `DATABASE_URL` the app
  stops at startup and says so. The app connects as `app_runtime`, a role the
  first start creates (the startup migration runs as the owner, the `app` user
  the services made, and makes the app role from `DATABASE_URL`): the same two
  roles as production ([deployment](deployment.md), "Database roles").
- **Mailpit** shows every mail the app sends: http://localhost:8025.
- **Two env files, never mixed:** `.env` (the root) is production's (Docker
  Compose reads it: secrets, project name); `apps/api/.env.development` is
  the app's settings in development, and `dev/compose.env` the development
  services' (their passwords match it). `pnpm services:up` never reads `.env`.
- **The app's files are in `apps/api`**, whatever directory it starts from
  (`apps/api/src/app-dir.ts`): `.env.development`, and `.data/` (local storage, mail
  as files). In the image that directory is `/app`.
- **Floci** is AWS on http://localhost:4566: files go to its S3, mail through
  its SES (then on to Mailpit), so development runs the code production runs.
- The first start creates the administrator (`ADMIN_EMAIL`); without
  `ADMIN_PASSWORD`, the password is logged once.
- Swagger UI at `/api`: sign in with `POST /v1/auth/sign-in`, then try the routes.

## Floci (AWS locally)

[Floci](https://github.com/floci-io/floci) (free, MIT-licensed, a LocalStack
replacement) starts with the bucket made and the sender verified
(`dev/floci/10-template.sh`: add the AWS resources your project needs there).
SES mail is listed at http://localhost:4566/_aws/ses and relayed to Mailpit.
Its data survives restarts (volume `floci_data`).

Not deploying to AWS (R2, MinIO, Resend, Postmark…)? Switch the lines at the
end of `apps/api/.env.development` (local disk, SMTP to Mailpit), point them at your
provider, and remove `floci` from `compose.dev.yaml`.

## Commands

| Command | Does |
| --- | --- |
| `pnpm start:dev` | API and workers, with reload |
| `pnpm build && pnpm lint && pnpm test && pnpm test:e2e` | the check before every commit (Turborepo: a task whose inputs didn't change is replayed from `.turbo/cache`) |
| `pnpm format` | Prettier on the TypeScript of every package (not on Markdown) |
| `pnpm db:generate` | a migration from the tables (after any `*.tables.ts` change) |
| `pnpm db:check` | the migrations match the schema |
| `pnpm migrate` | apply migrations as `DATABASE_OWNER_URL`, then make or check the app role of `DATABASE_URL` (what a deploy runs) |
| `pnpm services:up` / `services:down` | the development services |
| `pnpm client:generate` | the typed client's `openapi.json` and `schema.ts` (after any route change) |
| `pnpm client:check` | they match the API (CI) |

## Tests

- **Unit** (`*.spec.ts` next to the code): Vitest.
- **End to end** (`apps/api/test/*.e2e-spec.ts`): the whole app on real PostgreSQL 18
  and Redis, mail in memory (`node.waitForMail()`), storage in memory, a
  manual workflow clock. `apps/api/test/setup-env.ts` sets the environment before
  AppModule loads.
  - The run starts a throwaway PostgreSQL in **Docker** (on tmpfs, no fsync)
    and a `redis-server`, or uses `TEST_DATABASE_URL` and `REDIS_URL` (CI).
    Docker must be running; without it, set `TEST_DATABASE_URL` to a server
    where the role may create databases, the development one for instance
    (`apps/api/.env.development`'s `DATABASE_URL`, with `postgres` as the database).
  - The database is migrated once as a template; every `bootApp()` (and
    `testDatabase()`) gets a copy of its own, in milliseconds, and drops it
    when closed: tests never see each other's rows, and the run leaves the
    server as it found it.
  - **The run has the two roles of a deployment** ([deployment](deployment.md),
    "Database roles"), made and dropped with it: an owner (`owner_<run>`,
    `CREATEROLE`, no superuser, as a managed PostgreSQL gives) migrates the
    template, and every app under test connects as the app role
    (`app_<run>`, made by the same bootstrap `node dist/migrate` runs). A test
    that needs a table of its own creates it through `database.asOwner()`:
    the app role can't, and must not. `apps/api/test/database-roles.e2e-spec.ts`
    proves the role's limits.
  - Passwords are hashed with scrypt at N = 2^10 in the tests, not
    production's 2^17 (`bootApp()` replaces `PasswordHasher`, as the
    package suggests): every test boots an app and signs users in, and the
    full cost made the suite several times slower. Same code path; never
    assert the production parameters in an e2e test.
  - One file: `pnpm test:e2e test/notes.e2e-spec.ts` (the path inside
    `apps/api`). One shard, as CI runs it: `pnpm test:e2e --shard=1/2`.
    One unit test file: `pnpm --filter @nestjs-monorepo-template/api test
    src/core/http/route-key.spec.ts`.
- **Store contracts** (`apps/api/test/stores.e2e-spec.ts`): the lock and
  authentication stores against the suites their packages ship.
- `TEST_LOGS=1 pnpm test:e2e` shows the app's errors and warnings.

## Typed client

`packages/api-client` (`@nestjs-monorepo-template/api-client`, a pnpm
workspace package) is the client for web apps, mobile apps and scripts:
typed REST calls (openapi-fetch on types generated by openapi-typescript)
and typed realtime events (socket.io). It applies the
[conventions](api-conventions.md) itself: credentials, languages, an
`Idempotency-Key` per POST, problem details thrown as `ApiError`, cursor
pages, ETags. Usage, the bell-icon recipe included:
[its README](../packages/api-client/README.md).

- `pnpm client:generate` after changing a route, then commit
  `packages/api-client/openapi.json` and `packages/api-client/src/schema.ts`: they are the
  contract. It runs `pnpm openapi:dump` (`apps/api/src/openapi-dump.ts`): the
  document of `/api-json`, made without a server, database or Redis
  (NestJS's preview mode) and with a fixed environment, so it comes out the
  same on every machine.
- `pnpm client:check` regenerates both in a temporary directory and fails
  when the committed ones differ; `apps/api/test/api-client.e2e-spec.ts` also fails
  when the committed document isn't what the app serves.
- **Breaking changes:** on a pull request, CI's `openapi-diff` job compares the
  committed `openapi.json` with the base branch's using
  [oasdiff](https://github.com/oasdiff/oasdiff). `client:check` only catches
  drift; this catches what breaks a client: removed endpoints, fields and
  enum values, a new required parameter, a tightened request. The job's
  summary lists the breaking changes (errors and warnings) and the full
  changelog. A pull request without a base document (the first one) passes.
- **Report-only for now:** breaking changes are accepted while the template
  has no adopters, so the job never fails on them. Once the first project is
  built on the template, make it blocking: set `OASDIFF_FAIL_ON: ERR` in
  `.github/workflows/ci.yml` (`WARN` also fails on warnings). A deliberate
  break then ships as a new version (`/v2` next to `/v1`,
  [conventions](api-conventions.md)). Locally, against `main`:

  ```bash
  git show origin/main:packages/api-client/openapi.json > old.json
  docker run --rm --network none -v "$PWD:/specs:ro" -w /specs tufin/oasdiff:v1.33.0 breaking old.json packages/api-client/openapi.json
  ```
- A new realtime event (`Realtime.toPrincipal()`) goes into `RealtimeEvents`
  (`packages/api-client/src/realtime.ts`).
- `pnpm --filter @nestjs-monorepo-template/api-client build` compiles it on
  its own (no NestJS in it); `pnpm build` builds it before the packages that
  depend on it. Its unit tests run with `pnpm test`.
- The API's e2e tests use it as a workspace dependency
  (`"@nestjs-monorepo-template/api-client": "workspace:*"`), as a frontend
  does: [monorepo](monorepo.md), "Adding a frontend app".

## Database

- Change a `*.tables.ts`, run `pnpm db:generate`, review and commit `apps/api/drizzle/`.
  **Never write migrations or DDL by hand.**
- **Expand/contract:** a migration must leave the previous release working
  (that release runs on the new schema during a deploy, and again after a
  rollback): drop, rename or retype a column or table only a release after
  the code stopped using it ([pitfalls](pitfalls.md), "Migrations:
  expand/contract"). On a pull request, CI's `migration-lint` lists the
  destructive statements of the new migrations in its summary (report-only
  for now) and fails when a merged migration or journal entry is edited or
  deleted. Locally, with Docker: `node tools/migration-lint/lint.mjs --base
  origin/main` (after `git fetch`; a branch behind `main` is compared with
  their merge base, and its new journal entries must still come after
  `main`'s), or `node tools/migration-lint/lint.mjs apps/api/drizzle/*.sql` for
  given files; its tests: `node --test tools/migration-lint/lint.test.mjs`.
- Entity keys are `uuid` with `DEFAULT uuidv7()` (PostgreSQL 18): time-ordered,
  so they index well and serve as pagination cursors. Use `uuidPk()`.
- Services read the database through the transaction host and write with
  `inTransaction()` (core/database/transactions.ts): every query inside joins
  the transaction, in any service.
- The app never changes the schema at runtime: it connects as a role that
  may not ([deployment](deployment.md), "Database roles"). Anything that must
  create or alter an object belongs in a migration, run by `node dist/migrate`
  (or the startup migration in development) as the owner.

## Git workflow

`main` is never edited directly, not even for a one-line docs fix. Every change:

1. **A branch in its own worktree.** `git fetch origin`, then
   `git worktree add --no-track -b <type>/<name> .claude/worktrees/<name> origin/main`
   (`.claude/worktrees/` is in `.git/info/exclude`; `--no-track`, or the branch
   tracks `main` and a plain `git push` fails). Push with `git push -u origin HEAD`.
   Parallel work gets one worktree each, on disjoint files where possible.
2. **The check** (see CLAUDE.md) passes in the worktree. Commits follow
   Conventional Commits. The squash commit takes the commit's subject when the
   PR has one commit and the PR title otherwise (the repository's
   `COMMIT_OR_PR_TITLE` setting; GitHub counts merge commits too), so both
   must be conventional: the commit-msg hook checks each commit, CI the PR's
   title, and the commit's subject while it's the only one (below, "Git hooks").
3. **A pull request** to `main` on `origin`. Big features get two independent
   reviews (security and code) before merging; verify fix commits too, not
   only the first diff.
4. **Green CI**, then the worktree is removed
   (`git worktree remove .claude/worktrees/<name>`) and, from the main checkout,
   the PR is squash-merged (`gh pr merge <number> --squash --delete-branch`).
   Remove the worktree first: Git refuses to delete a branch that a worktree
   still has checked out.

Never rebase or force-push. Bring a branch up to date with `git fetch origin` and
`git merge origin/main`;
when `pnpm-lock.yaml` conflicts, regenerate it with `pnpm install` rather than
merging it by hand. Merge dependent PRs in order and merge `origin/main` into the
ones that fall behind.

## Git hooks

`pnpm install` sets them up ([lefthook](https://lefthook.dev), `lefthook.yml`).
They look at the staged files only, so a commit waits a second or two:

| Hook | Runs |
| --- | --- |
| `pre-commit` | Prettier on the staged TypeScript (`pnpm format`'s globs, never `docs/` or other Markdown), restaging what it fixes; then type-aware oxlint on the API's staged files |
| `commit-msg` | commitlint (`commitlint.config.js`): `type(scope)!: subject`, types `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, `revert`; any scope, several with commas. Merge commits (`git merge origin/main`) and git's `Revert "…"` pass |

- **Not in the hooks:** the build, the tests, `db:check`, `client:check`. The
  check before every commit and CI run them.
- **Skipping:** `git commit --no-verify` skips both hooks, `LEFTHOOK=0 git
  commit …` too; `LEFTHOOK_EXCLUDE=oxlint` skips one job.
- **CI** (`.github/workflows/commit-messages.yml`) checks what the squash
  merge can put on main, with the same rules except that merge commits,
  `fixup!` and version numbers fail there: the pull request's title, again whenever
  it's edited, and the subject of its commit while it has only one. A wrong
  title: edit it. A wrong single commit's subject changes only with a
  force-push: push a second commit instead (`git commit --allow-empty -m
  "chore: …"`), and the squash takes the title.
- **Worktrees share the hooks** (`.git/hooks`); `pnpm install` in any
  checkout (or `pnpm exec lefthook install`) writes them, pointing at that
  checkout's lefthook. Commits never rewrite them (`no_auto_install`). Where
  `CI=true` (CI, the image build) `pnpm install` leaves them alone.
- **A checkout that lacks the tools commits unchecked:** a job whose tool
  isn't in that checkout's `node_modules` (no `pnpm install` since the
  hooks arrived) skips (lefthook says so), and one without `lefthook.yml`
  runs nothing. So `git merge origin/main` brings the hooks in without
  failing; `pnpm install` afterwards turns them on.
- **Once, after the hooks reach `main`:** run `pnpm install` in the main
  checkout, so the shared hooks point at its lefthook rather than at a
  worktree's, which goes away with the worktree.
