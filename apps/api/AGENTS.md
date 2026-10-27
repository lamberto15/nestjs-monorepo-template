# apps/api: agent rules

The NestJS API. These add to the root [AGENTS.md](../../AGENTS.md). In
depth: docs/architecture.md, "Code style"; a feature's parts:
docs/adding-a-feature.md.

## Layers

NestJS's own building blocks, one job each, and no extra layers:

| Layer | Does | Never |
| --- | --- | --- |
| Controller (`*.controller.ts`) | HTTP: route, Zod body/query, `@Can()`, `@Api*` docs, maps the result to the response | queries the database, opens transactions, holds business rules |
| Service (`*.service.ts`) | the use case: checks, writes in one transaction with its audit entry and outbox events, reads | knows HTTP (requests, cookies, status codes beyond Nest's exceptions) |
| Repository (`*.repository.ts`) | only the queries of a table many services share (`UsersRepository`) | business rules; one per table |
| Processor, workflow, job | background work, calling services | serves HTTP |

- Services compose their own queries and filters (`access.sqlFilter()`,
  `list.where()`); no controller imports `drizzle-orm` (oxlint enforces it).
- Rows are plain data (`typeof table.$inferSelect`), no methods. A domain
  class only for real invariants (pricing, a stock ledger, a state machine),
  with a comment saying why.
- Grouping: core ← iam ← platform ← features; groups never import features.
- Heavy or slow work goes to a queue worker, never in the request.
- REST only, no HTML: the API's only page is Swagger UI at `/api`.
- Generic naming: `user` (people), `client` (systems); "staff" and the like
  are roles.

## Features and the database

- Every feature follows docs/adding-a-feature.md: tables with `uuidPk()` and
  `timestamps()`, the list declaration, routes, audit, tests. Changing one:
  edit its `<item>.record.ts`, then `pnpm feature:sync`.
- Never hand-write migrations or DDL: change a `*.tables.ts`, run
  `pnpm db:generate`, commit `apps/api/drizzle/` (extensions: docs/development.md,
  "Database").
- **No raw SQL.** Query with Drizzle's builder and the tables' columns:
  `select`/`insert`/`update`/`delete`, `insert().select()`,
  `update().set().from()`, `onConflictDoUpdate`, and the operators (`eq`,
  `inArray`, `isNull`, `exists`, `between`, `count()`…). `sql` only for an
  expression the builder lacks, inside a builder query (`lower(x)`,
  `excluded.x`, `x + 1`, JSONB operators), with columns as `${table.column}`,
  never a literal name. No `db.execute(sql`…`)`, `sql.raw()` or
  `client.query()` unless Drizzle has no API for it (advisory locks,
  `set_config`, catalogs, roles): then add the file to
  `tools/ci/raw-sql.allow.json` with the reason. `pnpm lint` fails otherwise.
- Services read through the transaction host (`database(this.txHost)`) and
  write with `inTransaction()`: every query joins the current transaction.
- After route changes, `pnpm client:generate`.

## Tests

- Unit tests (`*.spec.ts`) sit next to the code; e2e tests in
  `test/<name>.e2e-spec.ts` or `test/features/<name>/`. One file:
  `pnpm test:e2e test/tags.e2e-spec.ts`.
- Add to the feature's own spec. `test/edge-*.e2e-spec.ts` and
  `test/security.e2e-spec.ts` take a test only when the change is an edge
  case or a security fix.
- Platform behavior (tags, comments, attachments…) is tested on `TestItem`
  (`test/fixtures`), not on a real feature.

## Pitfalls

- Module order in `app.module.ts`: Platform, then Core, then Iam.
- Abstract base classes of injectables need `@Injectable()`; inject
  `ConfigService<Env, true>` with a value import.
