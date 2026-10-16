# Pitfalls already hit

- **A query outside its transaction** (a service handed the injected
  database instead of `tx`) didn't see the transaction's rows, or waited on
  its locks. Services read the database through the transaction
  host (`private get db() { return database(this.txHost); }`, see
  core/database/transactions.ts), so inside `inTransaction()` every query of
  every service joins it. Never call `db.transaction()` on an injected
  database in a service; only stores that must stay outside transactions
  (locks, sessions, idempotency) inject it with `@InjectDrizzle()`.
- **nestjs-cls hands Drizzle `{}` as transaction options**, which Drizzle
  turns into `set transaction ` (a syntax error): `DrizzleTransactionAdapter`
  drops empty options. Keep using it, not the plain adapter.
- **Module order:** `PlatformModule` before `CoreModule` before `IamModule`
  (idempotency outermost; rate limits before authentication). A warning
  `IdempotencyInterceptor runs inside …` means the order broke.
- **No `z.date()` in response schemas** (500 on `/api-json`): `z.iso.datetime()`.
- **Workflows and the services they call must not import each other**
  (undefined providers): keep the steps' service apart (`NotePublisher`).
- **Workflow durations** come from the environment and must not change while
  an instance runs; cast with `as Duration`.
- **Memory-hard hashing × the threadpool vs the container's limit:** scrypt
  takes 128 MiB per password hash outside the V8 heap, and Node runs 4 at
  once (libuv's threadpool), so four concurrent sign-ins added 512 MiB to a
  512 MiB api container and the kernel killed it (exit 137, OOM) under 5
  sign-ins/s; the heap limit says nothing about it. Every hash goes through
  `PasswordHashLimiter` (`PASSWORD_HASH_CONCURRENCY`, 503 `server_busy` past
  its queue), and the limit holds `heap + 128 MiB + concurrency × 128 MiB`
  ([deployment.md](deployment.md#resource-limits)). Raise one, size the
  others; never hash with `node:crypto` directly, and never lower the scrypt
  parameters to save memory. The package's hasher is replaced, not wrapped
  at call sites: its own services (sign-in, password reset) hash too. A
  flow that consumes something (a reset link) and then hashes takes the
  slot first (`limiter.run()`), or a 503 there would spend the link.
- **Abstract base classes of injectables need `@Injectable()`**: without it,
  TypeScript emits no constructor metadata and Nest injects `undefined`.
- **`ConfigService` in constructors:** type it `ConfigService<Env, true>`
  with a value import; a type alias imported with `import type` emits no
  metadata.
- **Empty env values:** `skipProcessEnv: true` makes `FOO=` read as unset.
- **Queued mail carries no mail class:** tests find mails by recipient and
  subject (`node.waitForMail({ to, subject })`).
- **exceljs' streaming reader** fails on some valid files: imports read the
  workbook whole.
- **`Intl.DateTimeFormat`** refuses `timeZoneName` together with
  `dateStyle`/`timeStyle`.
- **Duplicate incoming webhooks** are answered 200 by the package, empty,
  before the handler runs.
- **Webhook delivery to `http://127.0.0.1`** needs `WEBHOOKS_ALLOW_LOOPBACK=on`.
- **The access cache** is per process; `access.invalidate()` publishes to
  every instance. Call it after any change to roles, grants or org units.
- **Express 5 leaves `req.body` undefined** without a body: a schema whose
  fields are all optional goes through `z.preprocess((b) => b ?? {}, …)`.
- **Local hooks:** `.env*` files can't be written by Claude; `secrets/`
  folders are blocked; a name ending in SECRET, TOKEN or PASSWORD followed by
  a string literal is refused (make test values at runtime); shell commands
  that redirect to `/dev/null`, or that contain a recursive delete of a
  system path (even inside a heredoc), are refused: use the file tools.
  So are shell commands containing SQL's `DROP DATABASE` (or TABLE,
  SCHEMA); `dropdb` passes.
- **Shell aliases:** `grep` is ripgrep (`/usr/bin/grep -E` for GNU flags);
  `ls` is eza (`/bin/ls`).
- **Docker Hub's anonymous pull limit** can block image checks: retry later.

- **A path relative to the shell's directory** breaks in the monorepo: the
  root's scripts run in `apps/api`, a `node apps/api/dist/main` runs
  wherever it was typed. The app's own files (`.env.development`, `.data/`,
  the migrations, the OpenAPI dump's default target) resolve against its
  package (`apps/api/src/app-dir.ts`, `drizzle.ts`), which is `/app` in the
  image.

- **Turborepo hides undeclared variables** (strict mode): a `turbo run` task
  sees the system's variables and the ones `turbo.json` names, nothing else.
  A variable a task needs goes into its `env` (part of the cache key) or
  `passThroughEnv` (`test:e2e`: `REDIS_URL`, `TEST_DATABASE_URL`, `TEST_LOGS`).

- **Settings read from `process.env` before the app boots** (NestJS Observe's
  `instrument` in main.ts, packages such as @nestjs/storage and @nestjs/mail
  reading the AWS keys themselves) don't see what ConfigModule loads: it
  reads `.env.development` only while the modules initialize, and with
  `skipProcessEnv`. So main.ts imports `dev-env.ts` first, which puts the file
  into `process.env` in development (Node's `process.loadEnvFile`); without
  it, Observe's module started but, its `instrument` missing, traced nothing.
  Still declare such settings in a `*.env.ts` and pass them as options
  (`awsCredentials(config)`): validated, and the same in every process.

- **`Promise.all` of two queries takes two connections** (a page and its
  count). Fine with a pool of 10; with a pool of 1 every such request waits
  for itself and gets `503 database_busy`. Inside a transaction, queries run
  one after the other on its connection.

- **Shutdown with Redis down:** ioredis keeps commands in its offline queue
  (`maxRetriesPerRequest: null`, which BullMQ needs), and `quit()` waits
  behind them for ever. Close clients with `closeRedis()` (QUIT with a
  limit, then `disconnect()`). `main.ts` also exits after 25 s (api) / 55 s
  (worker, all) whatever hangs: keep these under Compose's
  `stop_grace_period` (30 s / 60 s) if you change either.

- **Shutdown order: queue workers before dispose().** Nest closes the HTTP
  server and socket.io (the Redis adapter's connections) before
  `onApplicationShutdown`, where @nestjs/bullmq closes its workers. A job
  finishing then emits realtime on a closed connection, an unhandled
  "Connection is closed." rejection (e2e flake in reports). `QueueWorkers`
  closes the workers in `beforeApplicationShutdown`, so jobs finish first.

- **The e2e suite needs Docker** (a throwaway PostgreSQL 18), or
  `TEST_DATABASE_URL` pointing at a server where it may create databases.
  Tests on a real server also catch what an in-process database hid:
  concurrent transactions, row locks, timeouts. A run killed before its
  teardown leaves its container (`template-tests-*`); the next run removes
  those older than an hour, `docker rm -f` does it sooner.

- **One environment per e2e file.** `ConfigModule.forRoot()` validates
  `process.env` when `app.module.ts` is imported, once per test file; a
  change to `process.env` between two `bootApp()` calls of the same file is
  not seen. A setting a file needs goes into its `vi.hoisted()` block
  (metrics, breached passwords, the bot-protection files), and a second
  setting means a second file.

- **Overriding a provider doesn't stop the original factory.** Tests override
  the exported Drizzle token, yet CoreModule's factory still ran for every
  app and migrated the server's `postgres` database (83 times a run) while
  the suite stayed green. Turn off a replaced factory's side effects too
  (`MIGRATE_ON_START=off` in setup-env.ts), and after changing test
  plumbing, run once against a server you can inspect: point
  `TEST_DATABASE_URL` at a throwaway container, then look at it
  (`psql -c '\l'`, tables in `postgres`). That is how the stray migration
  and 86 leftover test databases showed up.

- **The app's connection must not own its tables.** The postgres image's
  `POSTGRES_USER` is a superuser, and api, worker and migrate all connected as
  it: row-level security would have been skipped (superusers and owners
  bypass it) while every test stayed green. Now api and worker run as a role
  that owns nothing and can't run DDL, in production, development and every
  e2e test (docs/deployment.md, "Database roles"), and
  `database-roles.e2e-spec.ts` checks it. What it changed: the stores no
  longer migrate at startup (`migrate: false`), test fixtures that create a
  table go through `database.asOwner()`, and a copied test database must be
  the owner's (`CREATE DATABASE … OWNER`), since `public` belongs to
  `pg_database_owner`. `CREATE DATABASE` can't run inside a transaction
  (25001), so a privilege check on it must run outside one.

- **Test connections against CI's limit:** the local test PostgreSQL allows
  1000 connections, CI's service the default 100. Each e2e file running at
  once (`maxWorkers` in apps/api/vitest.config.e2e.ts) holds a pool of 10 per app it
  boots. Raise CI's `max_connections` before raising either.

- **`POSTGRES_PASSWORD` applies only to a new volume.** A `postgres_data`
  volume left by another stack under the same project name keeps its old
  password, and `migrate` fails with `28P01 password authentication failed`.
  Check what the volume holds; if it's empty, remove it and redeploy.

- **A `@Body({ schema })` hides `@ApiBody`.** @nestjs/swagger keeps a
  Standard Schema body over an explicit `@ApiBody`, so an upload's file
  field vanished from Swagger UI (no file picker on `POST /v1/data/imports`).
  Declare the file in the Zod body schema instead: `z.unknown().optional()
  .meta({ type: 'string', format: 'binary' })` (optional: Multer has taken
  it out of the body before validation; the route checks it).

- **`docker compose run -v vol:/path` can't make a read-only mount
  writable** (the service's `:ro` wins): mount the volume again at another
  path (`-v app_storage:/restore`, as the file restore does).

- **`/metrics` behind the rate limiter went dark with Redis.** The limiter
  counts in Redis, and ioredis queues commands while Redis is away, so every
  scrape hung until Prometheus gave up: the alerts saw the app down
  (`ApiDown`, `WorkerDown`) instead of `RedisUnreachableFromApp`. `/metrics`
  and `/health` skip the limiter (`@SkipThrottle()`); keep it so for
  anything a monitor polls. Then the scrape answered 500: a failed labelled
  gauge was cleared with `remove()` and no labels, which throws (prom-client);
  `collect()` now resets it. Both found by stopping Redis under the
  monitoring stack.

- **A Dependabot bump of Gotenberg is half a bump.** It raises the `FROM`
  line of `gotenberg/Dockerfile` (and, separately, `compose.dev.yaml`'s
  image), but not `GOTENBERG_VERSION` (the release its Go programs are built
  from) nor the other file: raise those by hand in the same pull request.
  CI's `gotenberg-image` job fails until the three agree.

## Migrations: expand/contract

A release's migrations must leave the release before it working, because
that release runs on the new schema twice:

- **During a deploy:** `migrate` runs first, while the old `api` and `worker`
  containers still serve; with several replicas, old and new code share the
  database until the last old one is replaced.
- **On a rollback:** rolling back is rolling the image back
  ([deployment](deployment.md), "Publishing and rolling back images").
  Migrations don't roll back, so the older image runs on the newer schema.

Drizzle names the columns of its tables' definitions in every select and
insert (`default` for those not given), so a column the old code doesn't know
is harmless, and one it knows that is gone fails its selects and inserts on
that table (`column does not exist`). Hence the rule: **never drop,
rename or retype a column or table, or add NOT NULL without a default to a
populated table, in the release that stops using it.** Expand first; contract
in a later release, once every release that may still run (the one being
replaced, the one a rollback returns to) no longer needs the old shape:

| Change | Expand | Contract (a release later) |
| --- | --- | --- |
| Drop a column or table | Stop reading and writing it. A NOT NULL column without a default becomes nullable (or gets a default) in the same release, or its inserts fail | Drop it |
| Rename or retype a column | Release 1: add the new column, write both (still reading the old one), backfill the rows (a queue job for a big table). Release 2: read and write the new one only, and make the old one nullable (or give it a default), or release 2's inserts fail; the lint reports that `DROP NOT NULL` (`ban-drop-not-null`), as expected | Drop the old one |
| Rename a table | As a column: create the new table, write both, backfill, then move to it | Drop the old one |
| A required column | Add it nullable or with a default; write it everywhere; backfill | `SET NOT NULL`; drop the default if it was only for the old code |
| Drop a default | Write the column on every insert | Drop the default |
| Drop an index, constraint, type or enum value | Stop relying on it (an enum value: stop writing it, update the rows that have it) | Drop it |
| Add a constraint (`UNIQUE`, a unique index, `CHECK`, a foreign key) | Make every release write rows that satisfy it, and fix the rows that don't: the previous release's writes that break it fail (the lint doesn't check this) | Add it |

With drizzle-kit, the contract is deleting the column (or table) from its
`*.tables.ts`: `pnpm db:generate` then writes the drop. So the expand release
keeps it in `*.tables.ts` (nullable, or with a default) and stops using it in
the code.

A rename takes three releases: rolling release 2 back to release 1 must find
the old column still there. (Release 1 then reads it as release 2 left it:
stale for the rows release 2 changed. Keep writing both in release 2 if that
matters.)

- **CI's `migration-lint`** (`.github/workflows/migrations.yml`,
  `tools/migration-lint/`) reads the migrations a pull request adds with
  [squawk](https://squawkhq.com) and lists, in the job summary with file and
  line, what breaks the release before: drops (tables, columns, types,
  indexes, constraints, defaults, NOT NULL...), renames, `SET DATA TYPE`,
  `SET NOT NULL`, `ADD COLUMN ... NOT NULL` without a default, `TRUNCATE`,
  `DELETE` and `UPDATE` without `WHERE`, `MERGE`'s `THEN DELETE` and `THEN
  UPDATE` (not those kept for later: a rule's action, a `BEGIN ATOMIC`
  function's body). A contract step trips it by design: say in the pull
  request which release expanded it. Report-only while the template has no
  adopters; `MIGRATION_LINT_FAIL: on` in the workflow makes it blocking, and
  a reviewed contract step then takes the `destructive-migration` label.
- **The label counts only when it was added after the latest push** (the
  first workflow run GitHub made for the head commit; a commit's own dates
  are the author's to set), and is read when the job runs, so a re-run sees
  it as it is. A push after the review needs the label removed and added
  again. The summary says when a label on the pull request doesn't count.
- **`squawk-ignore` comments** (`-- squawk-ignore <rule>`,
  `-- squawk-ignore-file`) would make squawk skip statements, and squawk has
  no option to refuse them. The lint blanks them before squawk reads the
  file and fails on them, report-only or not: a generated migration has none.
- **A merged migration is never edited, deleted or renamed**, and its journal
  entry (`apps/api/drizzle/meta/_journal.json`) never changes: databases that
  applied it keep the old version, new ones get the new, and nobody notices.
  A new entry must also be later than the base branch's last one: drizzle's
  migrator skips a migration older than the last it applied, which is what a
  hand-merged journal after a conflict produces. Delete your migration and run
  `pnpm db:generate` again on top of `main`. The lint fails on all of these
  whether blocking or not; only the label (a deliberate reset of the history)
  lets them through.
- **Early stage:** until the first project is built on the template, breaking
  changes are accepted ([roadmap](roadmap.md), "Early stage"): one release
  may drop or rename, app10's data is reset at the breaking migrations, and
  the pull request lists the break. The lint still reports it.
- **`ConditionalModule.registerWhen` needs a long `timeout`:** its timer starts
  when the module file is imported, not when `ConfigModule.forRoot` runs, so the
  5 s default ran out while a loaded machine was still importing the rest of the
  app (e2e: "Nest was not able to resolve the config variables within 5000
  milliseconds", an unhandled error that fails the run with every test green).
  Pass `{ timeout: 60_000 }` like the existing calls.
