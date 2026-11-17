# Development

```bash
pnpm install
pnpm run setup                # first run: the questions, then apps/api/.env.development (docs/configuration.md, "First setup")
pnpm services:up          # PostgreSQL 18, Redis 8, Mailpit, Floci (project <name>-dev)
pnpm dev                  # the API and its workers (http://localhost:3000/api) and the web app (http://localhost:5173), with reload
pnpm db:seed:demo         # optional, from a second terminal: demo users, organizational units and each feature's demo data (passwords printed once)
```

Then open the web app, http://localhost:5173, and sign in: as the
administrator the first start made (below), or as a demo member the seed
printed ([monorepo](monorepo.md), "Running it"). Swagger UI is at
http://localhost:3000/api.

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
  `ADMIN_PASSWORD`, the password is logged once. With the default
  `admin@example.com` or a generated password, the first sign-in is blocked
  until a real address and a new password are set (docs/auth.md,
  "Administrator onboarding"); `ADMIN_ONBOARDING=off` (in
  `env.development.example`) skips that locally.
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
tenant there is instead, whose administrator then acts as an operator): organizational units (Sales, Sales North
under it, Engineering), seven members (its administrator, two unit leads,
three editors, a viewer) in the seed roles, then each feature's own data
(`FeatureDefinition.demo`; the example feature's: four tags and seven notes
owned by those members, tagged, two with a comment that mentions a
colleague, one with a text file attached). The administrator is an editor
too, so an approver of the notes' publication: to try an approval, sign in
as them, turn `notes.publishApproval` on, have an editor (a password the
seed printed) write a note, and approve in the inbox what its publication
asks for ([approvals](approvals.md#the-notes-example)). Everything is in the demo
tenant: memberships, roles, units, the features' records, the files (under
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
    before). A production container
    (`NODE_ENV=production`) refuses before connecting to anything.
  - The database is marked as a development database: the database-wide
    setting `app.dev_database = on`. NODE_ENV alone proves nothing because
    development and production may run the same image. Only a superuser
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

## Dependencies are pinned

Every dependency in every `package.json` is an exact version, no `^` or `~`.
`saveExact: true` in `pnpm-workspace.yaml` makes `pnpm add` save it that way,
Dependabot (`versioning-strategy: increase`) raises the pinned version itself,
and `node tools/ci/pinned-deps.mjs` (part of `pnpm lint`) fails on a range in
`dependencies`, `devDependencies` or `optionalDependencies`. `engines`,
`devEngines` and `peerDependencies` stay ranges.

pnpm itself is pinned in three places that must agree: `devEngines.packageManager`
in the root `package.json` (what `pnpm install` and CI's `pnpm/setup` run) and the
`ghcr.io/pnpm/pnpm` image of `apps/api/Dockerfile` and `caddy/Dockerfile` (what
builds the images). The same check fails when they differ. Dependabot raises
only the images: when its pull request arrives, raise `devEngines` in it too.

## Commands

| Command | Does |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run setup` | the first-run wizard: asks the deployment shape and the few choices, writes the env file with generated secrets (`--dry-run`, `--yes`, `--rotate`; [configuration](configuration.md), "First setup") |
| `pnpm env:check` | an env file against its template, by name: the variables it lacks, the ones the template does not name, the REQUIRED ones that are empty (exit 1); `--strict`, `--target`, `--file`, `--templates` ([configuration](configuration.md), "First setup"; its tests: `node --test tools/setup/*.test.mjs`) |
| `pnpm dev` | the API and its workers, and the web app, with reload (Turborepo's `dev` task in both, the client built first) |
| `pnpm dev:api` / `pnpm start:dev` | the API and its workers alone, with reload (through Turborepo / straight through pnpm) |
| `pnpm start:debug` | the same with the Node.js inspector (`nest start --debug --watch`) |
| `pnpm dev:web` | the web app's dev server alone, http://localhost:5173; it proxies `/v1`, `/health`, `/files` and `/socket.io` to the API on :3000 (`apps/web/dev-proxy.ts`), so the session cookie is same-origin and a signed file link is too |
| `pnpm build && pnpm lint && pnpm test && pnpm test:e2e` | the checks CI runs on every pull request; run them locally only to investigate a CI failure (Turborepo: a task whose inputs didn't change is replayed from `.turbo/cache`) |
| `pnpm i18n:check` | the translation parity check (also run by `pnpm lint`): every locale's keys, placeholders and plural forms against `en`, web and API ([i18n](i18n-and-time.md)) |
| `pnpm lint` | oxlint in every package (Turborepo), the translation parity check, the pinned-versions and raw-SQL checks (`tools/ci/raw-sql.mjs`: the API's raw SQL against `tools/ci/raw-sql.allow.json`), then knip: unused files, exports and dependencies across the workspaces ([Dead code](#dead-code-knip)); `pnpm lint:code` is all but knip, `pnpm knip` knip alone |
| `pnpm format` | Prettier on the TypeScript of every package (not on Markdown, nor `packages/ui`: the shadcn CLI writes it) |
| `pnpm format:check` | the same files, `prettier --check`: what CI runs in `check`; `pnpm format` fixes it |
| `pnpm turbo run typecheck` | `tsc` over the API (`src` and `test`), the web app (`tsc -b`, tests included) and `packages/ui`; run by CI in `check` |
| `pnpm db:generate` | a migration from the tables (after any `*.tables.ts` change) |
| `pnpm db:generate:fixtures` | the test-only record's migrations (`apps/api/test/fixtures/drizzle`), after changing `test/fixtures/test-items` |
| `pnpm db:check` | the migrations match the schema |
| `pnpm db:studio` | Drizzle Studio on the development database |
| `pnpm migrate` | apply migrations as `DATABASE_OWNER_URL`, then make or check the app role of `DATABASE_URL` (what a deploy runs) |
| `pnpm db:seed:demo` | demo users, organizational units and each feature's demo data on a development database ("Demo data") |
| `pnpm ops <command>` | the operator CLI: a one-time password, remove two-factor, unlock, delete a setting, create an administrator ([deployment](deployment.md), "Operator CLI"); on a deployment: `docker compose run --rm api node dist/cli <command>` |
| `pnpm feature:add <plural> --fields "…" [--with …]` | a new feature from its declaration ([adding a feature](adding-a-feature.md)) |
| `pnpm feature:sync [<plural>]` | after editing a feature's `<item>.record.ts` (fields, capabilities, options): updates what the platform derives from it |
| `pnpm feature:remove <plural>` | a feature, its tests and texts, e.g. the example `notes` |
| `pnpm capability:remove <name>` | an optional platform capability nothing else uses (`ai`, `forms`): its folder, module, tables, variables, tests, pages and docs ([adding a feature](adding-a-feature.md), "Removing a platform capability") |
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
    `EXPIRE NX` of the failure counters is 7.0's), or uses `TEST_DATABASE_URL` and `REDIS_URL` (CI sets both).
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
    `apps/api`). One shard, as CI runs it: `pnpm test:e2e --shard=1/2`.
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
(the API's unit-only ones are low because its unit tests are the small
share), so main never fails on day one. They only ratchet: when a change lifts
the numbers, raise the thresholds with it; a drop fails CI.

The API's gate that counts is the **merged** one, unit and e2e together
(`apps/api/vitest.config.merge.ts`; the settings its three Vitest configs
share are in `vitest.coverage.ts`). Measured on 2026-11-17: statements
91.69%, branches 81.65%, functions 93.12%, lines 92.25%; the thresholds are
90/80/92/91. The unit-only 30/27/26/30 stay for `test:cov`.

- **Locally:** `pnpm --filter @nestjs-monorepo-template/web test:cov` (or
  `api`, `api-client`); `pnpm test` stays without coverage.
- **The API's merged coverage, locally:** run the unit tests and the e2e suite
  with `--coverage --reporter=default --reporter=blob` (the e2e one with
  `--outputFile.blob=.vitest/blob/e2e.json`, so the names don't collide), then
  `pnpm --filter @nestjs-monorepo-template/api exec vitest --merge-reports --coverage --config vitest.config.merge.ts`.
  The full e2e suite takes about 15 minutes on two workers.
- **In CI:** the API's and the packages' unit tests run as steps of `check`,
  and the web app's in the `unit-web` job (check name "unit (web)"). Each runs
  a whole `test:cov` task, not shards, and enforces the package's thresholds
  directly. Three-run benchmarks selected this layout for lower runner
  consumption. Coverage outputs are cached; database and browser E2E are not.
  The API's unit run and each e2e shard also upload a blob report
  (`coverage-api-*`); the **CI gate** job merges them and enforces the merged
  thresholds. The e2e shards run with coverage, which adds some time to each.
  See [CI measurements](ci-runtime.md).
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
  by `node dist/<name>`; the `tools/` scripts).
- **An unused export:** remove the `export` (or the code). A helper meant
  for the projects built on the template stays exported with a `@public`
  JSDoc tag, which knip leaves alone (`isEncrypted`, `withCan`, ...).
- **Ignored on purpose**, each with its reason in `knip.jsonc` or here:
  Dice UI's data table (`components/data-table/`, `lib/data-table-*.ts`:
  registry output the CLI writes, left whole so `shadcn add` updates apply),
  `react-day-picker` and `tailwindcss` (used by that registry code and the
  stylesheet's `@import`) and `redis-server` (the e2e tests start it).
- Ignoring is the last resort: prefer removing the dead code.

## Browser tests

`apps/web-e2e` is [Playwright](https://playwright.dev) driving Chromium
through the web app, as a user does: sign-in (password, the guard on a deep
link, sign-out), the notes list (server paging, a filter in the URL), creating,
viewing, editing, deleting and restoring a note, the notification bell, the
settings page (an administrator sees it, a viewer is sent away) and an
[axe](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright)
accessibility scan of the signed-out auth pages, the dashboard, the notes
list, a note, the settings and account pages, in the dark theme, in Arabic
(right to left) and on a phone, and of an open dialog, popover and menu. It is
not part of `pnpm test:e2e` (the API's).

- **What it runs against:** the _built_ API (`node dist/main`) and the _built_
  web app, served by `vite preview`, which proxies `/v1` to the API as Caddy
  does in production (`preview.proxy` in `apps/web/vite.config.ts`). One
  origin, so the `__Host-sid` cookie works; no CORS, no Vite dev server.
  The Caddy image would add a build of Caddy with its plugin for nothing else
  the tests check (it serves the same `dist`); its own image is built and
  scanned in CI (`caddy-image`).
- **The production CSP isn't sent here.** `test/fixtures.ts`'s context still
  listens for a `securitypolicyviolation` on every page (a worker's own don't
  reach it) and fails the test with what was refused, but `vite preview` stopped
  sending Caddy's headers when `apps/web/preview-headers.ts` was removed with
  the browser analytics feature it also served (#776): the listener is dead
  code until it either gets a header source again or is removed.
  `caddy/caddyfile.test.mjs` (deployment.md, "The web app's security headers")
  is the one place this policy is checked.
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
  AA) fail the test, and so do the rules in `LANDMARK_RULES`
  (`test/fixtures.ts`): the best-practice ones for one `<main>`, a level-1
  heading, content inside landmarks and a working skip link
  (`landmark-one-main`, `landmark-no-duplicate-main`, `page-has-heading-one`,
  `region`, `skip-link`, `bypass`). The other best-practice findings are only
  listed. Every finding is attached to the test and listed in the job summary
  (`node apps/web-e2e/scripts/axe-summary.mjs` prints the same after a run).
  A real finding is fixed in the web app; one that can't be yet gets an issue,
  and only then a `disableRules()` in `test/fixtures.ts` naming it. A rule is
  added to `LANDMARK_RULES` once it passes on every scanned page.
  `expectAccessible(page, name)` waits for the finite animations to end first;
  `{ scope: '[role="dialog"]' }` scans only an open overlay (the page behind a
  modal is inert, and the page-level rules are covered by the page's own
  scan). The dark theme and Arabic are set the way the app remembers them
  (`localStorage`), or by answering `GET /v1/auth/me` with `locale: 'ar'`, so
  no test changes the shared account. Unit tests of the same behaviour
  (`apps/web/src/test/navigation-a11y.test.tsx`): [monorepo](monorepo.md),
  "Accessibility".
- **In CI:** the `e2e-web` job of `.github/workflows/ci.yml`, on every pull
  request, beside the API's e2e shards: its own PostgreSQL and Redis service
  containers, the database marked as a development one, Turborepo's cache for
  the builds, the runner's own Google Chrome (`E2E_BROWSER_CHANNEL=chrome`:
  no browser download and no apt; unset, as locally, Playwright's Chromium),
  one retry. When an attempt failed, a retried one included, the HTML report
  and the traces (`playwright-report` artifact, 14 days) are uploaded.

## Typed client

`packages/api-client` (`@nestjs-monorepo-template/api-client`, a pnpm
workspace package) is the client for web apps, mobile apps and scripts:
typed REST calls (openapi-fetch on types generated by openapi-typescript)
and typed realtime events (socket.io). It applies the
[conventions](api-conventions.md) itself: credentials, languages, an
`Idempotency-Key` per POST, problem details thrown as `ApiError`, cursor
pages, ETags. Usage, the bell-icon recipe included:
[its README](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/packages/api-client/README.md).

- `pnpm client:generate` after changing a route, then commit
  `packages/api-client/openapi.json` and `packages/api-client/src/schema.ts`: they are the
  contract. It runs `pnpm openapi:dump` (`apps/api/src/openapi-dump.ts`): the
  document of `/api-json`, made without a server, database or Redis
  (NestJS's preview mode) and with a fixed environment, so it comes out the
  same on every machine.
- `pnpm client:check` regenerates both in a temporary directory and fails
  when the committed ones differ; `apps/api/test/api-client.e2e-spec.ts` also fails
  when the committed document isn't what the app serves.
- **Breaking changes** are not detected by CI: `client:check` only catches
  drift. Review the diff of `openapi.json` in the pull request; a deliberate
  break ships as a new version (`/v2` next to `/v1`,
  [conventions](api-conventions.md)). To list them locally against `main`
  with [oasdiff](https://github.com/oasdiff/oasdiff):

  ```bash
  git show origin/main:packages/api-client/openapi.json > old.json
  docker run --rm --network none -v "$PWD:/specs:ro" -w /specs tufin/oasdiff:v1.33.0 breaking old.json packages/api-client/openapi.json
  ```
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
  **Never write migrations or DDL by hand.** The one exception: what
  drizzle-kit can't emit (`CREATE EXTENSION`) goes in an empty migration from
  `drizzle-kit generate --custom --name=<what>`, a statement or two with a
  comment saying why (as `20261027221810_pg_trgm/migration.sql`).
- **The folder** (drizzle-kit 1.0): one `<timestamp>_<name>/` per migration,
  holding `migration.sql` and `snapshot.json` (the schema's change; the first
  holds the whole schema). There is no journal: the migrator applies every
  migration a database doesn't have, by name, in folder order. `pnpm
  db:check` (`drizzle-kit check`, in CI) fails on snapshots that disagree
  and on migrations of two branches that touch the same tables (merge
  `main`, delete your migration and `pnpm db:generate` again).
- **Expand/contract:** a migration must leave the previous release working
  (that release runs on the new schema during a deploy, and again after a
  rollback): drop, rename or retype a column or table only a release after
  the code stopped using it ([pitfalls](pitfalls.md), "Migrations:
  expand/contract"). On a pull request, CI's `migration-lint` lists the
  destructive statements of the new migrations in its summary and fails on
  them (a reviewed contract step takes the `destructive-migration` label),
  as when a merged migration is edited or deleted. Locally, with Docker:
  `node tools/migration-lint/lint.mjs --base origin/main` (after `git
  fetch`; a branch behind `main` is compared with their merge base), or
  `node tools/migration-lint/lint.mjs apps/api/drizzle/*/migration.sql` for
  given files; its tests: `node --test tools/migration-lint/lint.test.mjs`.
- **The Caddyfile:** `CADDY_BIN=/path/to/caddy node --test caddy/caddyfile.test.mjs`
  runs the real Caddyfile (its TLS block and Docker names edited out, every
  edit checked) under a real Caddy: the app, the maintenance page, the API's
  paths. Without a binary the tests are skipped; CI's `caddy-image` job runs them
  with the image's own ([deployment](deployment.md), "Maintenance page").
- **A new feature:** `pnpm feature:add <plural> --fields "…"`
  (`tools/feature/`, [adding a feature](adding-a-feature.md)); its tests:
  `node --test tools/feature/add.test.mjs`. CI's `feature-smoke` job
  generates three features with every option and runs their generated tests
  (comprehensive runs only: Sunday's, manual ones and tags).
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

1. **A branch in a worktree.** `git fetch origin`, then
   `git worktree add --no-track -b <type>/<name> .claude/worktrees/<name> origin/main`
   (`.claude/worktrees/` is in `.git/info/exclude`; `--no-track`, or the branch
   tracks `main` and a plain `git push` fails). Push with `git push -u origin HEAD`.
   Group related tasks and issues into one worktree and PR; use a separate one
   only for unrelated work, work needing its own review or revert, or work that
   would block the rest. Separate worktrees stay on disjoint files where possible.
2. **Push reviewable commits early and validate in CI** (see AGENTS.md).
   Open a draft PR after the first implementation commit while work continues;
   push incremental commits so CI runs during implementation. Do not run the
   full build/test suite locally and then repeat it in CI. Use focused local
   checks only to investigate CI failures or when the owner asks. Commits follow
   Conventional Commits. The squash commit takes the PR title (the repository's
   `PR_TITLE` setting), so it must be conventional: the commit-msg hook checks
   each commit, CI the PR's title, and the commit's subject while it's the only
   one (below, "Git hooks").
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

Several sessions (people or coding agents) work at once, often from the same GitHub
account, so the labels say what each issue and PR is about and who has it.

| Label | Meaning |
| --------------------- | ------------------------------------------------------------------- |
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
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | Prettier on the staged TypeScript (`pnpm format`'s globs, never `docs/` or other Markdown), restaging what it fixes; then type-aware oxlint on the apps' staged files (`apps/*/{src,test}`), after building the workspace packages (Turbo's cache: near-instant), whose types it needs |
| `commit-msg` | commitlint (`commitlint.config.js`): `type(scope)!: subject`, types `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, `revert`; any scope, several with commas. Merge commits (`git merge origin/main`) and git's `Revert "…"` pass |

- **Not in the hooks:** the build, the tests, `db:check`, `client:check`. The
  check before every commit and CI run them.
- **Skipping:** `git commit --no-verify` skips both hooks, `LEFTHOOK=0 git
  commit …` too; `LEFTHOOK_EXCLUDE=oxlint` skips one job.
- **CI** (`.github/workflows/commit-messages.yml`) checks, with the same rules
  except that merge commits, `fixup!` and version numbers fail there: the pull
  request's title, which the squash puts on main, again whenever it's edited,
  and the subject of its commit while it has only one. A wrong title: edit it.
  A wrong single commit's subject changes only with a force-push: push a second
  commit instead (`git commit --allow-empty -m "chore: …"`), and the check
  stops applying.
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
