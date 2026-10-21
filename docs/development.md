# Development

```bash
pnpm install
pnpm setup                # first run: the questions, then apps/api/.env.development (docs/configuration.md, "First setup")
pnpm services:up          # PostgreSQL 18, Redis 8, Mailpit, Floci, Gotenberg (project <name>-dev)
pnpm dev                  # the API and its workers (http://localhost:3000/api) and the web app (http://localhost:5173), with reload
pnpm db:seed:demo         # optional, from a second terminal: demo users, teams and each feature's demo data (passwords printed once)
```

Then open the web app, http://localhost:5173, and sign in: as the
administrator the first start made (below), or as a demo member the seed
printed ([monorepo](monorepo.md), "Running it"). Swagger UI is at
http://localhost:3000/api.

Or open the repository in its [devcontainer](#devcontainer): the same
services, Node.js and pnpm at the repository's versions, nothing to install;
`pnpm dev` there runs the API and the web app.

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
company in a tenant of its own, **Demo Company** (`demo`, never the
operators' tenant: [tenancy](tenancy.md); with `TENANCY=single`, the one
tenant there is instead, whose administrator then acts as an operator): teams (Sales, Sales North
under it, Engineering), seven members (its administrator, two team leads,
three editors, a viewer) in the seed roles, then each feature's own data
(`FeatureDefinition.demo`; the example feature's: four tags and seven notes
owned by those members, tagged, two with a comment that mentions a
colleague, one with a text file attached). The administrator is an editor
too, so an approver of the notes' publication: to try an approval, sign in
as them, turn `notes.publishApproval` on, have an editor (a password the
seed printed) write a note, and approve in the inbox what its publication
asks for ([approvals](approvals.md#the-notes-example)). Everything is in the demo
tenant: memberships, roles, teams, the features' records, the files (under
`tenants/<id>/`), the audit entries. The people are
`apps/api/src/demo/demo-data.ts`; a feature's data is its own
(`features/notes/notes.demo.ts`, [adding a feature](adding-a-feature.md)).

- **Through the services, as the system principal** `system:demo-seed`
  ([permissions](permissions.md), "The system principal"): a standalone
  application context (`NestFactory.createApplicationContext`, NestJS's way
  for scripts) of the app plus `DemoSeeder`, with no workers in it
  (`APP_ROLE=api`). Every write has its audit entry with the seed as the
  actor, and the job may do only what `demoSeedJob()` declares (the core's, the roles' grants, the features' `demo.permissions`)
  (`src/demo/demo.jobs.ts`), checked where a controller checks and where
  the services do (granting a role takes holding its permissions, and a
  job never holds `all.manage`). The notes are their users' (so `mine`
  and "in my units" show something), created on their behalf. What the
  seed starts (the notes' publication, their webhooks) waits in PostgreSQL
  for the app's workers: `pnpm dev` runs them.
- **Members with passwords, though adding people is invite-only**
  ([auth](auth.md)): no route lets an administrator set a password, and
  none is reopened for this. The seed uses the system-only path the first
  start uses for its administrator, `AccessAdminService.seedUser()`
  (refused to anything but a system principal made in code, no route
  calls it): a verified account (the seed made the address up; sign-in
  refuses unverified ones), its membership, roles and units, `user.seeded`
  with the seed as the actor. The demo administrator gets the
  Administrator role as every tenant's first administrator does
  (`TenantsService.addAdministrator()`, in the tenant's creating
  transaction): administrator of the demo tenant only, no operator.
- **Passwords are generated** and printed once, straight to stdout (never
  through the app's logger), with the addresses
  (`<first>.<last>@demo.example.com`): a fixed password would be in every
  breach list, which the breach check refuses. Each member signs in and
  lands in the demo tenant, their only one. Lost one? The password reset
  (`POST /v1/auth/password/forgot`; the mail is in Mailpit).
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
- **Once, all or nothing:** the demo tenant is made as every tenant is
  (`TenantsService.create()`: the row and its roles in one transaction in
  its scope), and everything else runs in that same transaction as
  `system.run(demoSeedJob(features), …, { tenantId })`, after an advisory lock and
  the checks. A database that already has the demo tenant or demo users is
  left alone ("already here", exit 0). To start over, drop the development
  database's volume (`pnpm services:down`, then
  `docker volume rm <name>-dev_postgres_data`).
- Its tests: `src/demo/demo-guard.spec.ts` (both halves of the check) and
  `test/demo-seed.e2e-spec.ts` (refused on an unmarked database and under
  another NODE_ENV, then a run on a marked one: members sign in to the demo
  tenant only, the roles' conditions, the operators see none of it, the
  audit; and a second run that changes nothing).

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
  folder). Then `pnpm dev` (the API and the web app; ports 3000 and 5173
  are forwarded, Mailpit's inbox as `mailpit:8025`) and `pnpm db:seed:demo`.
- **The web app** is at http://localhost:5173, as on the host: Vite's proxy
  reaches the API on the container's `localhost:3000`. The container sets
  `WEB_DEV_HOST=::`, which `apps/web/vite.config.ts` hands to Vite's
  `server.host`: Vite listens on every address, IPv4 and IPv6, so the
  forwarded port reaches it whichever loopback the editor uses (Vite's
  `localhost` default binds `::1` alone there). Nothing is published on the
  host; on the host the variable is unset and Vite keeps its default.
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
- **`node_modules` are the container's** (volumes, one per workspace
  package: the root, `apps/api`, `apps/web`, `packages/api-client`,
  `packages/ui`; `post-create.sh` gives them to the `node` user): the Linux
  binaries of oxlint, esbuild, turbo, lefthook, Vite's Rolldown and
  Tailwind's oxide never replace the host's. A package added to the
  workspace (a frontend under `apps/`, a library under `packages/`) needs a
  volume for its own `node_modules` too, and its line in `post-create.sh`'s
  `chown`.
- **PostgreSQL checks passwords on loopback too** (`POSTGRES_INITDB_ARGS:
  --auth-host=scram-sha-256`): the image trusts 127.0.0.1 by default, which
  is the workspace's way in; `database-roles.e2e-spec.ts` proves a rotated
  password is refused.
- **`pnpm migrate`** (what a deploy runs, also making the maintenance role
  of `DATABASE_MAINTENANCE_URL`) reads the environment only, as on the
  host: `set -a; . apps/api/.env.development; set +a; pnpm migrate` (the
  file's `MAIL_FROM` line upsets `sh`: harmless). `pnpm dev` and
  `pnpm db:seed:demo` migrate on start (`MIGRATE_ON_START`).
- **`devcontainer up` asks for `--allow=fs.read=…`** with a recent Docker
  (buildx bake checks the CLI's generated Dockerfile in a temporary
  directory): `BUILDX_BAKE_ENTITLEMENTS_FS=0 devcontainer up …`.
- **CI builds it** (`.github/workflows/devcontainer.yml`, when
  `.devcontainer/**`, `compose.yaml`, `compose.dev.yaml`,
  `apps/web/vite.config.ts`, `pnpm-lock.yaml` or the workflow change, and on
  demand): the pinned `@devcontainers/cli` runs `devcontainer up` (with
  `BUILDX_BAKE_ENTITLEMENTS_FS=0`; so `post-create.sh` and `pnpm install`),
  then `.devcontainer/smoke-test.sh` starts `pnpm dev` and fetches
  `127.0.0.1:5173/`, `[::1]:5173/` and `127.0.0.1:5173/health` (the API
  through Vite's proxy), failing on any answer outside 2xx and printing the
  dev server's log. Not a required check (a pull request that touches none
  of those files has no run). The same two steps run locally from the main
  checkout: `devcontainer up --workspace-folder .`, then
  `devcontainer exec --workspace-folder . sh .devcontainer/smoke-test.sh`.
  The CLI's version is raised by hand in the workflow.
- Dependabot raises the base image; pnpm's version is raised with
  `devEngines` by hand (`PNPM_VERSION`).

## Commands

| Command | Does |
| --- | --- |
| `pnpm setup` | the first-run wizard: asks the deployment shape and the few choices, writes the env file with generated secrets (`--dry-run`, `--yes`, `--rotate`; [configuration](configuration.md), "First setup") |
| `pnpm dev` | the API and its workers, and the web app, with reload (Turborepo's `dev` task in both, the client built first) |
| `pnpm dev:api` / `pnpm start:dev` | the API and its workers alone, with reload (through Turborepo / straight through pnpm) |
| `pnpm start:debug` | the same with the Node.js inspector (`nest start --debug --watch`) |
| `pnpm dev:web` | the web app's dev server alone, http://localhost:5173; it proxies `/v1`, `/health` and `/socket.io` to the API on :3000, so the session cookie is same-origin |
| `pnpm build && pnpm lint && pnpm test && pnpm test:e2e` | the check before every commit (Turborepo: a task whose inputs didn't change is replayed from `.turbo/cache`) |
| `pnpm i18n:check` | the translation parity check (also run by `pnpm lint`): every locale's keys, placeholders and plural forms against `en`, web and API ([i18n](i18n-and-time.md)) |
| `pnpm lint` | oxlint in every package (Turborepo), the translation parity check, then knip: unused files, exports and dependencies across the workspaces ([Dead code](#dead-code-knip)); `pnpm lint:code` is the first two, `pnpm knip` knip alone |
| `pnpm format` | Prettier on the TypeScript of every package (not on Markdown, nor `packages/ui`: the shadcn CLI writes it) |
| `pnpm db:generate` | a migration from the tables (after any `*.tables.ts` change) |
| `pnpm db:generate:fixtures` | the test-only record's migrations (`apps/api/test/fixtures/drizzle`), after changing `test/fixtures/test-items` |
| `pnpm db:check` | the migrations match the schema |
| `pnpm db:studio` | Drizzle Studio on the development database |
| `pnpm migrate` | apply migrations as `DATABASE_OWNER_URL`, then make or check the app role of `DATABASE_URL` (what a deploy runs) |
| `pnpm db:seed:demo` | demo users, teams and each feature's demo data on a development database ("Demo data") |
| `pnpm ops <command>` | the operator CLI: a one-time password, remove two-factor, unlock, delete a setting, create an administrator ([deployment](deployment.md), "Operator CLI"); on a deployment: `docker compose run --rm api node dist/cli <command>` |
| `pnpm feature:add <plural> --fields "…" [--with …]` | a new feature from its declaration ([adding a feature](adding-a-feature.md)) |
| `pnpm feature:sync [<plural>]` | after editing a feature's `<item>.record.ts` (fields, capabilities, options): updates what the platform derives from it |
| `pnpm feature:remove <plural>` | a feature, its tests and texts, e.g. the example `notes` |
| `pnpm deploy:rolling` / `deploy:blue-green` / `deploy:swarm` | zero-downtime deploys ([deployment](deployment.md), "Zero-downtime deploys: three ways") |
| `pnpm db:mark-dev` | mark the development services' database as a development one, once, for a volume made before the marker |
| `pnpm services:up` / `services:down` | the development services |
| `pnpm client:generate` | the typed client's `openapi.json` and `schema.ts` (after any route change) |
| `pnpm client:check` | they match the API (CI) |

## Tests

- **Unit** (`*.spec.ts` next to the code, in `apps/api` and
  `packages/api-client`): Vitest.
- **Web** (`*.test.ts(x)` next to the code, in `apps/web`): Vitest in jsdom,
  Testing Library, the API answered by msw; part of `pnpm test`. One file:
  `pnpm --filter @nestjs-monorepo-template/web test src/features/notes/notes.test.tsx`.
  The helpers (`renderApp()`, `findToast()`, the msw handlers) and the
  timing settings: [monorepo](monorepo.md), "Tests". Browser end-to-end
  tests are their own suite (below, "Browser tests").
- **End to end** (`apps/api/test/*.e2e-spec.ts`): the whole app on real PostgreSQL 18
  and Redis, mail in memory (`node.waitForMail()`), storage in memory, a
  manual workflow clock. `apps/api/test/setup-env.ts` sets the environment before
  AppModule loads.
  - The run starts a throwaway PostgreSQL in **Docker** (on tmpfs, no fsync)
    and a `redis-server` (Redis 7.0 or newer, as the app requires: the
    `EXPIRE NX` of the failure counters is 7.0's), or uses `TEST_DATABASE_URL` and `REDIS_URL` (CI,
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
  - One file: `pnpm test:e2e test/tags.e2e-spec.ts` (the path inside
    `apps/api`). One shard, as CI runs it: `pnpm test:e2e --shard=1/6`.
    One unit test file: `pnpm --filter @nestjs-monorepo-template/api test
    src/core/http/route-key.spec.ts`.
- **The platform's record is test-only** (`apps/api/test/fixtures`): the
  test app is `createAppModule([...FEATURES, TEST_ITEMS_FEATURE])`
  (`TestAppModule`), so tags, comments, attachments, revisions, search,
  tenancy… are tested on `TestItem` (`/v1/test-items`, `node.writeItem()`)
  whatever features a project keeps. It's a generated feature with its own
  migrations (`test/fixtures/drizzle`, from `pnpm db:generate:fixtures`,
  applied to the template after the app's) and texts
  (`test/fixtures/i18n`); no app database ever gets them.
  `openapi.e2e-spec.ts` boots `AppModule` alone. A feature's own tests live
  in `test/<name>.e2e-spec.ts` or `test/features/<name>/`, which
  `pnpm feature:remove` takes with it.
- **Browser tests** (`apps/web-e2e`): see "Browser tests" below.
- **Store contracts** (`apps/api/test/stores.e2e-spec.ts`): the lock and
  authentication stores against the suites their packages ship.
- `TEST_LOGS=1 pnpm test:e2e` shows the app's errors and warnings.

## Coverage

Each package that has unit tests sets coverage thresholds in its
`vitest.config.ts` (`test.coverage.thresholds`): `apps/api`, `apps/web` and
`packages/api-client`. They sit at the levels measured when they were added
(the API's is low because its unit tests are the small share; the e2e suite
carries the rest and isn't measured), so main never fails on day one. They
only ratchet: when a change lifts the numbers, raise the thresholds with it;
a drop fails CI.

- **Locally:** `pnpm --filter @nestjs-monorepo-template/web test:cov` (or
  `api`, `api-client`); `pnpm test` stays without coverage.
- **In CI:** the unit job's shards run `test:cov` (the same run, not a second
  one): each writes a blob report (`.vitest/blob`) and checks no threshold
  of its own, since a share of the tests covers a share of the code. The
  `coverage` job merges the blobs (`vitest --merge-reports --coverage`) and
  enforces the thresholds. The packages job runs whole and enforces its own.
- **Measure again** before raising: run `test:cov` and read the summary; set
  each threshold to the figure rounded down.

## Dead code (knip)

`pnpm lint` ends with [knip](https://knip.dev) (`knip.jsonc`, one entry per
workspace, as its monorepo guide describes): files nothing imports, unused
exports and types, and dependencies that are unused or not listed. CI runs it
in the `check` job. The generated-template jobs run `pnpm lint:code`, since
knip checks this repository's own code.

- **Entry points** knip can't find on its own are listed in `knip.jsonc`
  (the worker, `migrate`, `seed-demo`, `openapi-dump` and the CLI, started
  by `node dist/<name>`; the `tools/` scripts; the load test).
- **An unused export:** remove the `export` (or the code). A helper meant
  for the projects built on the template stays exported with a `@public`
  JSDoc tag, which knip leaves alone (`isEncrypted`, `withCan`, ...).
- **Ignored on purpose**, each with its reason in `knip.jsonc` or here:
  Dice UI's data table (`components/data-table/`, `lib/data-table-*.ts`:
  registry output the CLI writes, left whole so `shadcn add` updates apply),
  `react-day-picker` and `tailwindcss` (used by that registry code and the
  stylesheet's `@import`), `@types/multer` (the global `Express.Multer`
  types), `k6` (the load test runs in k6's container) and `redis-server` (the
  e2e tests start it).
- Ignoring is the last resort: prefer removing the dead code.

## Browser tests

`apps/web-e2e` is [Playwright](https://playwright.dev) driving Chromium
through the web app, as a user does: sign-in (password, the guard on a deep
link, sign-out), the notes list (server paging, a filter in the URL), creating,
viewing, editing, deleting and restoring a note, the notification bell, the
settings page (an administrator sees it, a viewer is sent away) and an
[axe](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright)
accessibility scan of the sign-in, dashboard, notes list, note detail and
settings pages. It is not part of `pnpm test:e2e` (the API's).

- **What it runs against:** the *built* API (`node dist/main`) and the *built*
  web app, served by `vite preview`, which proxies `/v1` to the API as Caddy
  does in production (`preview.proxy` in `apps/web/vite.config.ts`). One
  origin, so the `__Host-sid` cookie works; no CORS, no Vite dev server. The
  Caddy image would add a build of Caddy with its plugin for nothing the tests
  check (it serves the same `dist`); its own image is built and scanned in CI
  (`caddy-image`).
- **Ports:** the API on **3300** and the web app on **4173**, never 3000 and
  5173, so the suite runs beside `pnpm dev`. Nothing it uses is the default
  stack's but PostgreSQL and Redis (see below).
- **Run it locally:**

  ```bash
  pnpm services:up                                   # PostgreSQL and Redis (the development services)
  pnpm --filter @nestjs-monorepo-template/web-e2e exec playwright install chromium   # once
  pnpm test:e2e:web                                  # builds the API and the web app, seeds, tests
  ```

  `playwright test` starts both servers itself (`webServer` in
  `playwright.config.ts`; one already on those ports is reused outside CI).
  Its report is `apps/web-e2e/playwright-report/` (`pnpm exec playwright
  show-report` there). One file: `pnpm test:e2e:web test/notes.spec.ts`; the
  UI mode: `pnpm --filter @nestjs-monorepo-template/web-e2e exec playwright
  test --ui`.
- **Another database:** the environment is the development services' (the
  defaults of `apps/web-e2e/scripts/api.mjs`, from `env.development.example`);
  set `DATABASE_URL`, `DATABASE_OWNER_URL`, `DATABASE_MAINTENANCE_URL` and
  `REDIS_URL` for others, e.g. a throwaway PostgreSQL and Redis on other host
  ports (the database marked as a development one, "Demo data"). The suite
  writes to the database it runs on (notes), and seeds the demo data once.
- **Accounts:** `scripts/api.mjs` runs the demo seed, then the API.
  The seed's generated passwords are kept in `apps/web-e2e/playwright/.auth/`
  (ignored by git); `test/auth.setup.ts` signs in once per role (administrator,
  editor, viewer) and saves each browser state, which the tests reuse
  (`storageState`), since the API allows 5 sign-ins per email per 15 minutes
  (the script multiplies the limits by 20 for a database that is reused).
  A database seeded earlier prints nothing: the file from that run stays, or
  `E2E_CREDENTIALS` names another. Lost it: drop the database's volume.
- **Accessibility:** serious and critical axe violations (WCAG 2.0/2.1 A and
  AA) fail the test; every finding is attached to it and listed in the job
  summary (`node apps/web-e2e/scripts/axe-summary.mjs` prints the same after a
  run). A real finding is fixed in the web app; one that can't be yet gets
  an issue, and only then a `disableRules()` in `test/fixtures.ts` naming it.
- **In CI:** the `e2e-web` job of `.github/workflows/ci.yml`, on every pull
  request, beside the API's e2e shards: its own PostgreSQL and Redis service
  containers, the database marked as a development one, Turborepo's cache for
  the builds, Chromium cached by Playwright's version
  (`~/.cache/ms-playwright`; the system libraries installed with
  `--with-deps`), one retry. On a failure the HTML report and the traces
  (`playwright-report` artifact, 14 days) are uploaded.

## Load tests

A baseline of what four routes cost under load on the production stack, and
a socket.io check beside it, kept from run to run, so a change that makes one twice as slow fails, and the
cost of tenancy's row-level security ([roadmap](roadmap.md), 1a) can be
measured against numbers taken before it ([roadmap](roadmap.md), 17-lite).

The same stack serves two more checks: the **restore drill**
(`scripts/restore-drill.sh`, [deployment.md](deployment.md), "Restore drill")
and **PgBouncer** (`LOADTEST_PGBOUNCER=on` adds `compose.pgbouncer.yaml`,
"PgBouncer"). `loadtest/run.sh compose <args>` runs any `docker compose`
command on it.

| Scenario | Request | Load (one minute each, one after the other) |
| --- | --- | --- |
| `signIn` | `POST /v1/auth/sign-in`, 20 seeded users | 2/s (below) |
| `list` | `GET /v1/notes` with filters and a sort (status, `title.contains`, `createdAt.gte`…), the load-test client's key | 50/s |
| `create` | `POST /v1/notes` with an `Idempotency-Key`, the same key | 20/s |
| `export` | `POST /v1/data/exports` (notes, CSV, the load-test client's key), then `GET /v1/data/transfers/{id}` every 500 ms until `completed` with its link | 1/s |
| realtime | socket.io, `/realtime` (Artillery, below) | 10 new connections/s |

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
  `setup()` makes it and 300 notes through the API, as the administrator
  the stack seeds, whose password `run.sh` generates per stack; the
  sign-in scenario signs that administrator in (an account signs in only
  once its address is proved, by mail, which a load test can't do for
  accounts of its own: docs/tenancy.md). `setup()` first checks the target's rate limit is raised (only a
  load-test stack's is), so k6 pointed at a real deployment seeds nothing.
- **The bot check (roadmap item 4) is off by default:** the baseline
  measures the app, not a captcha, so `compose.loadtest.yaml` sets
  `CAPTCHA_MODE=off` unless `LOADTEST_CAPTCHA=always` asks for it, and k6
  then sends no captcha token. **Its cost** is measured with
  `LOADTEST_CAPTCHA=always`: the guard is in place with the **stub
  provider** (`CAPTCHA_PROVIDER=stub`, which judges by the token's text and
  calls nothing, [auth](auth.md), "Bot protection"), and k6 sends a fresh
  `X-Captcha-Token: stub:pass:<uuid>` on the administrator's sign-in
  (`/v1/auth/token`, in `setup()`) and on the sign-in scenario. The stub
  runs under `NODE_ENV=production` **only with `APP_ENV=loadtest`**, which
  only this overlay sets; production, any other `APP_ENV` and a Turnstile
  secret next to it still refuse it at startup
  (`captcha.providers.spec.ts` proves it). The cost is the difference
  between two runs: `loadtest/run.sh` once as usual, once with
  `LOADTEST_CAPTCHA=always` in another `LOADTEST_OUT`, then
  `node loadtest/compare.mjs --report-only --current captcha/baseline.json --previous plain/baseline.json`
  (the baseline records `captcha`; a different bot check is compared, since
  its cost is the point). It measures the guard (the replay set in Redis and
  the verdict), not Cloudflare's round trip, which the stub doesn't make.
  `RATE_LIMIT_MULTIPLIER` raises the throttler's limits only, not the
  captcha's fail-open tier (`CAPTCHA_DEGRADED_LIMIT`), which an off captcha
  never reaches.
- **The export** runs a real transfer each time: the request is queued, the
  worker reads the load-test client's 300 notes into a CSV in storage, and
  the iteration ends when the transfer reads `completed` with its link. The
  baseline has the request's latency (`ms`) and the time to a ready file
  (`readyMs`: median, p95, max), which `compare.mjs` holds to the same 2×
  bar; a transfer that fails or isn't ready in 60 s counts as an error.
- **Realtime** (`loadtest/realtime.yml`) uses **Artillery** (pinned in
  `run.sh`, `ARTILLERY_IMAGE`) because k6 doesn't speak socket.io. Each
  virtual user connects to `/realtime` through Caddy (websocket only),
  authenticated with the administrator's token (signed in once by
  `realtime.processor.cjs`: a custom step, since the engine can't template
  a handshake header from an HTTP answer), asks `whoami` once a second for
  ten seconds (each acknowledged), and leaves. It measures the handshake,
  the message round trip and the connections held (rate × 10 at once); a
  refused handshake or a missing answer fails the run, as do a p95 over 500
  ms or a p99 over 2 s (`ensure`). It does **not** measure the delivery of a
  pushed event (`record.commented`, `data.export-ready`): a follow-up. Its
  report is `realtime.json` in the output directory; it is not part of
  `baseline.json` and not compared between runs.
- **Several replicas:** `LOADTEST_REPLICAS=4 loadtest/run.sh` runs 1 to 6
  api replicas behind Caddy (default 2, `compose.prod.yaml`'s). Each holds
  10 database connections of PostgreSQL's 100, hence the limit of 6. The
  baseline records `replicas`; runs with a different count aren't compared
  (the numbers are another stack's), so a scaling comparison is read by eye
  or with `--report-only`. The CI run stays at 2 (the anchor's).

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
LOADTEST_REPLICAS=4 LOADTEST_OUT=/tmp/lt4 loadtest/run.sh   # four api replicas
LOADTEST_CAPTCHA=always LOADTEST_OUT=/tmp/ltbot loadtest/run.sh   # the bot check in place (stub provider)
loadtest/run.sh up && loadtest/run.sh realtime && loadtest/run.sh down   # only the socket.io run
LOADTEST_REALTIME=off loadtest/run.sh   # without the Artillery run
```

**The baseline** (`baseline.json`, the `load-test-baseline` artifact of
each run, kept 90 days) has, per scenario, its rate, the requests made, the
failed share, the dropped iterations (requests k6 couldn't start on time:
the stack didn't keep up with the rate), and the latency in milliseconds
(`avg`, `med`, `p90`, `p95`, `p99`, `max`), with the commit, k6's image, the
api replicas and the bot check's mode.

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
- **The record panels' shared shapes are named components.** Every feature's
  `…/{id}/comments`, `/attachments`, `/tags` and `/revisions` answer the same
  shapes, so the document has them once, as `components.schemas`, and each
  route `$ref`s them: `Comment`, `CommentPage`, `Attachment`, `AttachmentPage`,
  `TagRef`, `TagRefList`, `Revision`, `RevisionPage`, `RevisionDiff` (and the
  `/v1/tags` ones, `Tag` and `TagPage`). They are there in every project, even
  when no feature has a panel (after `pnpm feature:remove` of the last one), so
  a frontend types its panels from them, not from whichever feature's route
  exists:

  ```ts
  import type { components } from '@nestjs-monorepo-template/api-client';

  type Comment = components['schemas']['Comment'];
  type CommentPage = components['schemas']['CommentPage']; // { items: Comment[]; nextCursor; … }
  type Revision = components['schemas']['Revision'];
  type RevisionDiff = components['schemas']['RevisionDiff'];
  ```

  To name another shape shared by several routes, give its Zod schema
  `.meta({ id: 'Name' })` (as `commentSchema` does): `@nestjs/swagger` moves
  the schema's definitions into `components.schemas` and the routes reference
  them. A component no route uses is left out of the document: list it in
  `PANEL_COMPONENT_SCHEMAS` (`platform/records/panel-components.ts`) to have it
  always, and add it to `PANEL_COMPONENTS` in `test/openapi.e2e-spec.ts`.
- A new realtime event (`Realtime.toPrincipal()`) is declared in the manifest
  (`platform/realtime/realtime-events.ts`: name, description, payload schema);
  `pnpm client:generate` then writes `src/realtime-events.ts` (generated, with
  `schema.ts`; `client:check` fails when stale) and `RealtimeEvents` follows.
- `pnpm --filter @nestjs-monorepo-template/api-client build` compiles it on
  its own (no NestJS in it); `pnpm build` builds it before the packages that
  depend on it. Its unit tests run with `pnpm test`.
- The API's e2e tests use it as a workspace dependency
  (`"@nestjs-monorepo-template/api-client": "workspace:*"`), as a frontend
  does: [monorepo](monorepo.md), "Adding another frontend app".

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
- **A new feature:** `pnpm feature:add <plural> --fields "…"`
  (`tools/feature/`, [adding a feature](adding-a-feature.md)); its tests:
  `node --test tools/feature/add.test.mjs`. CI's `feature-smoke` job
  generates two features with every option and runs their generated tests.
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

### Issues and labels

Several sessions (people or Claude) work at once, often from the same GitHub
account, so the labels say what each issue and PR is about and who has it.

| Label | Meaning |
| --- | --- |
| `backend` | `apps/api`, the typed client's generation, migrations, backend docs |
| `frontend` | `apps/web`, `packages/ui` |
| `ci` | workflows, images, Compose and deploys |
| `documentation` | docs only |
| `enhancement` / `bug` | new work or a fix: one of the two on every issue and PR |
| `in progress` | someone is working on it (the comments say who and where) |

A change that touches several areas gets each label
(`gh pr create --label backend,enhancement`). Work found outside your area
becomes an issue with that area's label: the problem, the evidence
(`file:line`, the request and response) and a proposal.

Issues also carry one priority label:

- `P0`: critical, a security or data-leak bug.
- `P1`: high.
- `P2`: medium.
- `P3`: low.

Sessions pick `P0` first, then `P1`, `P2`, `P3`. Within a priority, a `bug` comes
before an `enhancement`, and the `backend` issue before the `frontend` issue that
depends on it.

Picking up an issue:

1. Skip it if it's already labelled `in progress`.
2. Claim it: `gh issue edit <n> --add-label "in progress" --add-assignee @me`,
   then `gh issue comment <n>` with the branch (and the PR once it exists).
   The assignee alone can't tell two sessions on one account apart.
3. Open the PR early, as a draft (`gh pr create --draft`), its body saying
   `Closes #<n>`: GitHub links the two and closes the issue on the merge.
   Abandoning it: remove the label and comment why.

## Git hooks

`pnpm install` sets them up ([lefthook](https://lefthook.dev), `lefthook.yml`).
They look at the staged files only, so a commit waits a second or two:

| Hook | Runs |
| --- | --- |
| `pre-commit` | Prettier on the staged TypeScript (`pnpm format`'s globs, never `docs/` or other Markdown), restaging what it fixes; then type-aware oxlint on the apps' staged files (`apps/*/{src,test}`) |
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
