# Development

```bash
pnpm install
pnpm services:up          # PostgreSQL 18, Redis 8, Mailpit, Floci (project <name>-dev)
cp apps/api/env.development.example apps/api/.env.development   # points the app at them
pnpm start:dev            # the API and the workers, with reload: http://localhost:3000/api
pnpm db:seed:demo         # optional: demo users, notes, tags (passwords printed once)
```

Or open the repository in its [devcontainer](#devcontainer): the same
services, Node.js and pnpm at the repository's versions, nothing to install.

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

## Demo data

`pnpm db:seed:demo` fills a development database with a small, believable
company: org units (Sales, Sales North under it, Engineering), six users in
the example roles (two team leads, three editors, a viewer), four tags, and
seven notes owned by those users, tagged, two with a comment that mentions a
colleague, one with a text file attached. The data is
`apps/api/src/demo/demo-data.ts`: change it with your features.

- **Through the services, as the system principal** `system:demo-seed`
  ([permissions](permissions.md), "The system principal"): a standalone
  application context (`NestFactory.createApplicationContext`, NestJS's way
  for scripts) of the app plus `DemoSeeder`, with no workers in it
  (`APP_ROLE=api`). Every write has its audit entry with the seed as the
  actor, and the job may do only what `DEMO_SEED_JOB` declares
  (`src/demo/demo.jobs.ts`), checked where a controller checks and where
  the services do (granting a role takes holding its permissions, so the
  seed can't make an administrator). The notes are their users' (so `mine`
  and "in my units" show something), created on their behalf. What the
  seed starts (the notes' publication, their webhooks) waits in PostgreSQL
  for the app's workers: `pnpm start:dev` runs them.
- **Passwords are generated** and printed once, with the addresses
  (`<first>.<last>@demo.example.com`): a fixed password would be in every
  breach list, which sign-up and password changes refuse. Lost one? Set a
  new one as the administrator (`PATCH /v1/access/users/{id}`).
- **Development databases only, by a positive check**: it runs only when
  both say so, and refuses (exit 1, nothing written) otherwise:
  - `NODE_ENV` is set to `development` (or `test`). Unset doesn't count,
    although the app treats it as development: `env.development.example`
    sets it (add `NODE_ENV=development` to a `.env.development` made
    before), the devcontainer too. A production container
    (`NODE_ENV=production`) refuses before connecting to anything.
  - The database is marked as a development database: the database-wide
    setting `app.dev_database = on`. NODE_ENV alone proves nothing (app10
    runs the same image), so the database must say it too. Only a superuser
    can write the setting: the app's role can't, nor an administrator through
    the API, so a production database never has it. The development
    services set it when they create their database
    (`dev/postgres/10-dev-database.sql`, mounted into PostgreSQL's
    `docker-entrypoint-initdb.d`); a volume made before this needs it once:
    `pnpm services:up && pnpm db:mark-dev` (Compose's `exec` into the
    development project's PostgreSQL, never another project's).
- **Once:** everything is one transaction under an advisory lock, and a
  database that already has demo users is left alone ("already here",
  exit 0). To start over, drop the development database's volume
  (`pnpm services:down`, then `docker volume rm <name>-dev_postgres_data`) or
  delete the demo users.
- **Tenancy** ([roadmap](roadmap.md), 1a) adds the demo tenant in one
  place: `DemoSeeder.seed()` creates it before `system.run()` and passes it
  `{ tenantId }`.
- Its tests: `src/demo/demo-guard.spec.ts` (both halves of the check) and
  `test/demo-seed.e2e-spec.ts` (refused on an unmarked database and under
  another NODE_ENV, then a run on a marked one, and a second that changes
  nothing).

## Devcontainer

`.devcontainer/` is a [development container](https://containers.dev)
(VS Code's Dev Containers, GitHub Codespaces, `devcontainer up`): a
workspace with Node.js 24 and pnpm 12.11.2 (the versions of `package.json`'s
`devEngines`), psql and redis-cli, next to the development services
(PostgreSQL, Redis, Mailpit, Gotenberg) taken from `compose.yaml` and
`compose.dev.yaml` with `extends`, so their pinned images are the same.

- **No Floci (AWS locally)**, to keep it lean: nothing in the development
  workflow needs it. Files go to the local disk (`apps/api/.data`) and mail
  over SMTP straight to Mailpit, the app's own alternatives to S3 and SES
  (set in the container's environment). To work on the S3 or SES code
  paths, use `pnpm services:up` on the host, which runs Floci.

- **Open the main checkout**, not a worktree: a worktree's `.git` file
  points at a path on the host, which the container doesn't have.
- **On creation** (`.devcontainer/post-create.sh`): `pnpm install`, and
  `apps/api/.env.development` copied from `apps/api/env.development.example`
  when there is none (yours, if you have one, comes with the repository's
  folder). Then `pnpm start:dev` (port 3000 is forwarded; Mailpit's inbox
  as `mailpit:8025`) and `pnpm db:seed:demo`.
- **The services' addresses:** the workspace shares PostgreSQL's network,
  so the file's `127.0.0.1:5432` reaches it; Redis, Mailpit and Gotenberg
  are reached by name, set in the container's environment
  (`.devcontainer/compose.yaml`) with `STORAGE_DRIVER=local` and
  `MAIL_TRANSPORT=smtp`: the environment wins over the file. `NODE_ENV` is
  `development` there, and the database is marked as a development one when
  it's created: the demo seed runs.
- **The e2e tests** use the container's services instead of starting their
  own: `TEST_DATABASE_URL` (the server, as its superuser, whose password is
  `PGPASSWORD`) and `REDIS_URL` are set (see "Tests"). No Docker inside the
  container: the load tests run on the host.
- **Its own Compose project** (`nestjs-monorepo-template-devcontainer`),
  with its own volumes and nothing published on the host, so it runs beside
  `pnpm services:up` and never near a production stack:
  `.devcontainer/compose.yaml` is its only file, so Compose never reads the
  root's `.env` (production's).
- **`node_modules` are the container's** (volumes): the Linux binaries of
  oxlint, esbuild, turbo and lefthook never replace the host's. A frontend
  added under `apps/` needs a volume for its own `node_modules` too.
- Dependabot raises the base image; pnpm's version is raised with
  `devEngines` by hand (`PNPM_VERSION`).

## Commands

| Command | Does |
| --- | --- |
| `pnpm start:dev` | API and workers, with reload |
| `pnpm build && pnpm lint && pnpm test && pnpm test:e2e` | the check before every commit (Turborepo: a task whose inputs didn't change is replayed from `.turbo/cache`) |
| `pnpm format` | Prettier on the TypeScript of every package (not on Markdown) |
| `pnpm db:generate` | a migration from the tables (after any `*.tables.ts` change) |
| `pnpm db:check` | the migrations match the schema |
| `pnpm migrate` | apply migrations as `DATABASE_OWNER_URL`, then make or check the app role of `DATABASE_URL` (what a deploy runs) |
| `pnpm db:seed:demo` | demo users, notes and tags on a development database ("Demo data") |
| `pnpm db:mark-dev` | mark the development services' database as a development one, once, for a volume made before the marker |
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
    and a `redis-server`, or uses `TEST_DATABASE_URL` and `REDIS_URL` (CI,
    and the [devcontainer](#devcontainer), which sets both).
    Docker must be running; without it, set `TEST_DATABASE_URL` to a
    superuser of a server of your own, the development one for instance
    (`apps/api/.env.development`'s `DATABASE_OWNER_URL`, with `postgres` as
    the database): the run makes its roles and databases there, and the demo
    seed's test marks its database as a development one, which only a
    superuser may.
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

## Load tests

A baseline of what three routes cost under load on the production stack,
kept from run to run, so a change that makes one twice as slow fails, and the
cost of tenancy's row-level security ([roadmap](roadmap.md), 1a) can be
measured against numbers taken before it ([roadmap](roadmap.md), 17-lite).

| Scenario | Request | Load (one minute each, one after the other) |
| --- | --- | --- |
| `signIn` | `POST /v1/auth/sign-in`, 20 seeded users | 2/s (below) |
| `list` | `GET /v1/notes` with filters and a sort (status, `title.contains`, `createdAt.gte`…), the load-test client's key | 50/s |
| `create` | `POST /v1/notes` with an `Idempotency-Key`, the same key | 20/s |

- **What runs:** `loadtest/run.sh` starts `compose.yaml` + `compose.prod.yaml`
  (api ×2, worker, migrate, PostgreSQL, Redis: the image and limits a
  deployment runs) with `compose.loadtest.yaml` on top (named with `-f`: an
  exported `COMPOSE_FILE` is ignored), under its own project name and its
  own generated env file (`loadtest/results/stack.env`: the repository's
  `.env` is never read).
  The project must be named `loadtest-<name>` (`loadtest-local`, CI
  `loadtest-ci`; `LOADTEST_PROJECT`): any other name stops the script before
  it does anything, since `down` removes the project's volumes and must never
  reach a deployment, whatever a project made from the template is called. k6 (`loadtest/scenarios.js`, pinned image) runs in
  the stack's network against `http://caddy`, nothing is published on the
  host, and the stack and its volumes are removed at the end.
- **What the overlay changes:** Caddy is the stock `caddy` image on plain
  HTTP (the production one needs a Cloudflare token for its certificate),
  with the same balancing (`loadtest/Caddyfile`); the backup service is left
  out.
- **No limit is turned off.** k6's requests come from one address and sign
  the same users in hundreds of times, so the stack sets
  `RATE_LIMIT_MULTIPLIER=1000` (every rate limit ×1000, the throttler still
  runs: [configuration](configuration.md)) with `APP_ENV=loadtest`: under
  `NODE_ENV=production` the app refuses to start with a multiplier above 1
  and any other `APP_ENV`, so the overlay added to a deployment by mistake
  stops it rather than raising its limits. List and create go through
  a **dedicated API client**, `load-test`, with a daily quota of 10 million
  (the quota is counted on every request, as for any client). `k6`'s
  `setup()` makes it, the users and 300 notes through the API, as the
  administrator the stack seeds. The users' password is generated per stack
  by `run.sh` (`LOADTEST_USER_PASSWORD`; k6 refuses to seed without it), and
  `setup()` first checks the target's rate limit is raised (only a
  load-test stack's is), so k6 pointed at a real deployment seeds nothing.
- **The bot check (roadmap item 4) is off:** the load test measures the
  app, not a captcha, so `compose.loadtest.yaml` sets `CAPTCHA_MODE=off`
  (whatever its default becomes) and k6 sends no captcha token. Measuring
  the guard's own cost would need its stub provider, which production
  refuses, allowed with `APP_ENV=loadtest`: a follow-up.
  `RATE_LIMIT_MULTIPLIER` raises the throttler's limits only, not the
  captcha's fail-open tier (`CAPTCHA_DEGRADED_LIMIT`), which an off captcha
  never reaches.

**Why sign-in runs at 2/s only:** a password check (scrypt, N = 2^17) takes
about 0.4 s of a CPU and 128 MiB outside the heap, and libuv runs four at
once per process. At 5/s, more than two replicas of one CPU can hash, the
checks queue, four run at once, and the api container passes its 512 MiB
(`API_MEMORY`) and is OOM-killed (found by the first local run: 84–97% of
sign-ins failed while replicas restarted). That is a capacity limit to fix
on its own (bound the hashes in flight per process, or size `API_MEMORY`
for four); the baseline measures below it.

Locally (Docker; about five minutes plus the image's build):

```bash
loadtest/run.sh                      # up, run, down; the table at the end
cat loadtest/results/baseline.json   # the baseline
node loadtest/compare.mjs --current loadtest/results/baseline.json --previous old.json
loadtest/run.sh up && loadtest/run.sh run && loadtest/run.sh down   # keep the stack between runs
node --test loadtest/compare.test.mjs loadtest/run.test.mjs   # the comparison's and run.sh's tests
SIGN_IN_RATE=1 PHASE_SECONDS=20 loadtest/run.sh   # a lighter load (not comparable with CI's)
```

**The baseline** (`baseline.json`, the `load-test-baseline` artifact of
each run, kept 90 days) has, per scenario, its rate, the requests made, the
failed share, the dropped iterations (requests k6 couldn't start on time:
the stack didn't keep up with the rate), and the latency in milliseconds
(`avg`, `med`, `p90`, `p95`, `p99`, `max`), with the commit and k6's image.

**In CI** (`.github/workflows/load-test.yml`): **manual only for now**, to
save Actions minutes: Actions → Load test → Run workflow, on `main`, on a
GitHub runner (4 CPUs). To run it on a schedule again (weekly, say), add
`schedule: [{ cron: '37 2 * * 1' }]` under the workflow's `on:`; scheduled
runs on `main` count as references like dispatched ones. Each run builds
the image, runs `run.sh` and uploads the baseline, then
`loadtest/compare.mjs` compares it with two references from `main` and
writes a table for each to the job summary:

- **the previous run**: the latest successful manual (or scheduled) run on
  `main`, for a sudden regression;
- **the anchor** (the `load-test-anchor` artifact): the last run accepted
  with `record_only`, or the first baseline, for a slow creep that the
  previous run never shows (1.9× a run fails against it two runs later).
  It expires after 90 days; the next passing run on `main` becomes the new
  anchor.

- **It fails only on a 2× regression** against either reference: a
  scenario whose median or p95 reached twice the reference's and grew by at
  least 20 ms (a 3 ms route at 7 ms is a runner's noise), or whose failed
  share or dropped iterations reached twice the reference's (above 0.5% of
  the requests). A scenario whose rate or phase length changed isn't
  compared. A missing reference compares nothing: the first run records only.
- **A broken or saturated run never becomes the baseline:** more than 1%
  failed requests, or more than 1% of a scenario's iterations dropped, fails
  k6's thresholds, so the run fails and the next one compares with the last
  good one.
- **Reading a regression:** the summary names the scenario and the stat
  (`p95 120 → 260 ms (×2.17)`). Open the two runs' commits
  (`commit` in each baseline): the change between them is the suspect. Rerun
  once (Run workflow) before digging: a GitHub runner is shared hardware, and
  a single slow run happens. Twice slower on a rerun: profile that route.
- **Accepting a change** (a route slower by design, row-level security for
  instance): run the workflow on `main` with `record_only` checked. That run
  compares nothing and, if it passes, becomes both the previous run and the
  anchor the next run compares with. Dispatched on another branch it
  counts for neither: only runs on `main` are references.
- **Pull requests** that change `loadtest/`, `compose.loadtest.yaml` or the
  workflow run it too, report-only and never as a baseline.
- **No self-hosted runner.** The numbers come from GitHub's runners only. A
  self-hosted one (the owner's Mac) would only ever run behind
  `workflow_dispatch`, never on a schedule or a pull request: a pull
  request's code must never run on it.
- **k6's version** (`K6_IMAGE` in `loadtest/run.sh`, tag and digest) is raised
  by hand, as oasdiff's and squawk's are; a new version may move the numbers,
  so raise it with a `record_only` run.

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
- **Its version:** a change to the client (a route change too: it changes
  `openapi.json`) comes with a changeset, `pnpm changeset`; a version pull
  request on `main` turns them into its version and `CHANGELOG.md`. CI
  reports a client change without one ([releases](releases.md), "The typed
  client").
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
