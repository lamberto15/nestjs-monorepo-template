# Adding a feature

Every feature is built the same way, so the API is uniform for its clients
and the code for whoever reads it. Copy `apps/api/src/features/notes/` and keep its
shape; this page is the standard it follows. Check the NestJS docs and the
installed `@nestjs/*` packages first: use what they offer before writing it.

```
features/notes/
  notes.feature.ts                      what the groups take (defineFeature): listed in features/index.ts
  notes.module.ts                       the module
  notes.tables.ts                       tables
  notes.env.ts                          environment
  note.schemas.ts                       Zod bodies and responses
  note.policy.ts                        permissions and the @Policy() class
  note.resource.ts                      the resource declaration (audit, custom fields)
  note.list.ts                          the list's filters, sorts and fields
  note.transfer.ts                      exporter and importer
  note.bulk.ts                          bulk delete, restore, change
  notes.service.ts                      writes and reads
  notes.controller.ts                   /v1/notes
  note-events.ts                        webhook event types, the workflow signal
  note-publication.workflow.ts          the workflow
  note-publisher.service.ts             the workflow's steps (webhooks, realtime)
  note-approvals.ts                     publishing needs approval (the declaration, its handler)
  example-sender-webhook.controller.ts  an incoming webhook
```

Names: plural for the module, the tables, the environment, the service and
the controller (`notes.*`); singular for what describes one record
(`note.*`, `note-*`). Below, `<x>` is the plural, `<item>` the singular.

## The standard, step by step

1. **Table** (`<x>.tables.ts`; a number people quote: `sequences.next()` on
   create, [sequences.md](sequences.md)), with the column helpers of
   `core/database/columns.ts`:
   ```ts
   export const invoices = pgTable('invoices', {
     id: uuidPk(),                     // UUIDv7, time-ordered: also the default sort and cursor
     tenantId: tenantColumn(),         // the tenant (docs/tenancy.md): filled from the scope
     ownerId: text('owner_id').notNull(),
     ...moneyColumns('total'),         // money: total_minor (bigint) + total_currency (ISO 4217), money.md
     unitPrice: numeric('unit_price').notNull(), // unit prices and rates: numeric, read as strings
     dueOn: date('due_on'),            // a calendar date: date(); a moment: at('…')
     custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default({}), // only with custom fields
     ...timestamps(),                  // created_at, updated_at (set on every update)
   }, (t) => [
     ...tenantTable('invoices', t),    // row-level security policies, unique (tenant_id, id)
     index('invoices_owner_id_idx').on(t.ownerId),
   ]).enableRLS();
   ```
   - **Every feature table is a tenant table** ([tenancy](tenancy.md)):
     `tenantId: tenantColumn()`, `...tenantTable('<x>', t)` and `.enableRLS()`;
     the role bootstrap refuses a table with a `tenant_id` and no wall.
     Inserts leave `tenantId` out (it comes from the request's tenant);
     queries need nothing: row-level security keeps them in the tenant.
   - Uniques are per tenant (`uniqueIndex(…).on(t.tenantId, t.number)`), and a
     key to another tenant table is composite: `tenantReference('<x>_<y>_fk',
     [t.tenantId, t.yId], [y.tenantId, y.id])`, never a plain `references()`.
   - Work that leaves the request carries the tenant by type: queue jobs
     (`withTenant()`, a `TenantWorkerHost` processor), workflow inputs and
     signals (`tenantId`), cron jobs (`Tenancy.forEachTenant()`).
   - Every entity table: `id: uuidPk()` and `...timestamps()`. Link and log
     tables (rows added and removed, never edited) don't need `updated_at`.
   - Snake_case column names, camelCase properties; moments are `at()`
     (timestamptz, UTC), never `timestamp()` without a zone.
   - An index for every foreign key and for what lists filter or sort by.
   - Export it from `apps/api/src/features/tables.ts`, run `pnpm db:generate`, commit
     `apps/api/drizzle/`. Never write a migration by hand.
2. **Schemas** (`<item>.schemas.ts`): Zod for bodies and responses, which
   validates and documents at once.
   - Responses carry `id`, `createdAt`, `updatedAt`; dates as
     `z.iso.datetime()` (never `z.date()`), in UTC.
   - Create and update bodies are separate schemas; updates are partial
     (`PATCH`), and `null` clears a nullable field.
   - Entity types from the table: `typeof table.$inferSelect`.
3. **Permissions** (`<item>.policy.ts`): `definePermissions()` (subjects,
   actions, conditions with `casl()` and `sql()`, restrictable `fields`,
   `clientPermissions`, `seedRoles`) and a `@Policy()` class; add it to
   `IamModule.forRoot({ permissions })`. Lists filter in SQL
   (`access.sqlFilter()`), single records are checked on the loaded row.
4. **Resource** (`<item>.resource.ts`): `defineResource({ subject, audit: {} })`;
   each write calls `audit.recordChange()` in its transaction (diffs per
   field; `updatedAt` is never diffed; `expand` diffs an object per key).
5. **Soft delete** (optional: a recycle bin, for records people delete by
   mistake): the table spreads `...softDeletable()` (`deleted_at`,
   `deleted_by`, plus an index on `deleted_at`); the resource declares
   `softDelete: { table }` and is listed in `IamModule.forRoot({ resources })`;
   the subject gets a `restore` action. Then:
   - `access.sqlFilter()` leaves deleted rows out of every list, count and
     export, and `access.can()` refuses every action on a deleted record but
     `restore`: nothing to remember in queries. `findOne()` excludes them
     (404) unless asked for the bin.
   - `DELETE` sets `deletedAt`/`deletedBy` (audited `<x>.deleted`),
     `POST /:id/restore` clears them (`<x>.restored`), the list declares
     `softDelete: true` for `?deleted=true` (the bin, filtered with the
     `restore` permission).
   - SoftDeletePurgeJob deletes for good after `retentionDays`
     (SOFT_DELETE_RETENTION_DAYS, 30), and with the records, in the same
     transaction, the platform's data about them: comments, tag links,
     watchers, revisions (each registers into `RecordPurgeRegistry`;
     attachments keep their nightly sweep). A unique column of such a table needs a
     partial index (``.where(sql`deleted_at is null`)``), or a deleted record
     keeps its value taken.
   Not for link tables, logs, or records with a real "inactive" state (users
   and API clients deactivate). Notes is the example.
6. **Custom fields** (optional): a `custom` JSONB column with a GIN index,
   `defineCustomFields({ subject, table, column })` in the resource file,
   added to `PlatformModule.forRoot({ customFields })`. The service parses
   values with `customFields.parseValues()` and merges them with
   `mergeValues()`; responses pass through `customFields.visible()`.
   See [custom fields](custom-fields.md).
7. **List** (`<item>.list.ts`): one declaration, `listQuery(fields, { select })`
   (searchable text: a `searchVector()` column and `...searchFields()`,
   [api-conventions.md](api-conventions.md), "Search"):
   ```ts
   export const INVOICE_LIST = listQuery({
     status: { column: invoices.status, type: 'enum', values: STATUSES, ops: ['eq', 'in', 'notIn'] },
     unitPrice: { column: invoices.unitPrice, type: 'number', ops: ['gte', 'lte', 'between'], sortable: true },
     dueOn: { column: invoices.dueOn, type: 'date', ops: ['lt', 'gte', 'between', 'isNull'], sortable: true },
     createdAt: { column: invoices.createdAt, type: 'datetime', ops: ['gte', 'lt', 'between'], sortable: true },
     updatedAt: { column: invoices.updatedAt, type: 'datetime', ops: ['gte', 'lt', 'between'], sortable: true },
   }, { select: Object.keys(invoiceSchema.shape) });
   ```
   - Always `createdAt` and `updatedAt` (filterable, sortable): clients sync
     with `updatedAt.gte`.
   - Declare only what's indexed on a large table; nothing undeclared can be
     filtered, sorted or selected (400).
   - A field may sort by another expression than its column, ``sort:
     sql`lower(${t.name})` `` (an order that ignores case; index that
     expression). The page then selects `list.sortSelect(query)` next to the
     row for the cursor, and `list.pick()` drops it (as `NotesService.findPage`).
   - The page (as `NotesService.findPage`): `and(access.sqlFilter(…),
     list.where(query))`, ordered by `pageOrder(table.id, query)`,
     `.offset(pageOffset(query))`, `countPage()` beside it, `toPage()`.
     Then `access.redactAll()` on the items, and `list.pick(page, query)` last.
   - With custom fields: `@Query() raw` + `@ApiListQuery(LIST, …)`, then
     `customFields.extendList(LIST, subject)`, `list.parse(raw)`, and
     `select({ ...getTableColumns(t), ...list.sortSelect(query) })`
     (`NotesController.list`). Without: `@Query({ schema: LIST.schema })`.
8. **Service** (`<x>.service.ts`): owns the logic and the queries; no HTTP
   in it. It reads the database through the transaction host:
   ```ts
   constructor(private readonly txHost: TransactionHost<DrizzleTransactions>) {}
   private get db() { return database(this.txHost); }
   ```
   Each write is one `inTransaction(this.txHost, async (tx) => …)` with its
   side effects (audit entry, outbox events, workflow starts). Every query in
   it, and in the services it calls (`audit.recordChange()`…), joins that
   transaction by itself; nested `inTransaction()` calls join the outer one.
9. **Controller** (`<x>.controller.ts`): HTTP only, never the database.
   - `/v1/<x>`: `GET` list, `GET /:id`, `POST` (201, `@Idempotent()`),
     `PATCH /:id`, `DELETE /:id` (204); actions as `POST /:id/<verb>`.
    `@Etag()` on the routes that return the record, `assertUnchanged(ifMatch,
    shown)` before an update or delete ([api-conventions.md](api-conventions.md),
    "Concurrency and caching").
   - `@Can()` on the route, or a check on the loaded record; field-level
     checks on writes (`field_forbidden`).
   - `@ApiOperation`, `@Api*Response` with the Zod schemas; errors are
     problem details (throw Nest's exceptions with a `code`).
   - **Record-level routes are declared, not written.** The platform builds
     `/<x>/{id}/tags`, `comments`, `attachments`, `revisions`, `pdf`, `watch`
     and `POST /<x>/bulk` from one `RecordRouteSpec` (`<x>.routes.ts`:
     subject, path, Swagger tag, class name, noun), and the module lists the
     controllers its targets back:
     ```ts
     controllers: [
       InvoicesController,
       tagRoutes(INVOICE_ROUTES),
       commentRoutes(INVOICE_ROUTES),
       revisionRoutes(INVOICE_ROUTES, { restored: invoiceSchema }),
       bulkRoutes(INVOICE_ROUTES, { name: 'invoices', body: invoiceBulkSchema, docs }),
       watchRoutes(INVOICE_ROUTES),
     ],
     ```
     Each factory lives with its module (`platform/<module>/<module>.routes.ts`,
     the spec in `platform/records/record-routes.ts`); `docs` overrides say
     what the feature's records hold (notes: `features/notes/note.routes.ts`).
   - Acting on many records at once (delete, restore, change): a
     `BulkOperation` (`<item>.bulk.ts`) and `bulkRoutes()`, each item through
     the same service call ([bulk-operations.md](bulk-operations.md)).
   - Watching its records: a `SubscriptionTarget` (`<item>-subscriptions.ts`,
     who may watch: whoever may read) registered into `SubscriptionsRegistry`,
     and `watchRoutes()`.
10. **Notifications** (optional): declare the types the feature sends
    (`<x>-notifications.ts`, `defineNotifications()`, passed to
    `PlatformModule.forRoot({ notifications })`), their texts in
    `apps/api/src/i18n/<locale>/notifications.json`, and call
    `notifications.notify(tx, …)` in the write's transaction
    ([notifications.md](notifications.md)).
    Comments on its records: a `CommentTarget` (`<item>-comments.ts`)
    registered into `CommentsRegistry`, a `<subject>.commented` type, and
    `commentRoutes()` ([comments.md](comments.md)).
    Files attached to its records: an `AttachmentTarget` (`<item>-attachments.ts`)
    registered into `AttachmentsRegistry`, and `attachmentRoutes()`
    ([attachments.md](attachments.md)).
    A PDF of its records: a `DocumentSource` (`<item>-documents.ts`) registered
    into `DocumentsRegistry`, a template in `apps/api/src/documents/templates/`,
    its labels in `i18n/<locale>/documents.json`, and
    `documentRoutes(spec, { source })` ([documents.md](documents.md)).
    Tags on its records: a `TagTarget` (`<item>-tags.ts`) registered into
    `TagsRegistry`, `tagRoutes()`, `...tagFilter('<Subject>', <x>.id)` in the
    list, `tagsOf()` for the responses ([tags.md](tags.md)).
    Revisions of its records (history, diff, restore): a `RevisionTarget`
    (`<item>-revisions.ts`) registered into `RevisionsRegistry`,
    `revisions.record(tx, …)` in the create and update transactions, and
    `revisionRoutes(spec, { restored })` ([revisions.md](revisions.md)).
    Approval before an action (publish, pay, grant): `defineApproval()` in
    `<item>-approvals.ts` with an `ApprovalHandler` registered into
    `ApprovalsRegistry`, the declaration in `PlatformModule.forRoot({ approvals })`,
    `approvals.request()` where the action is asked for and
    `assertNotPending()` in the writes that must wait ([approvals.md](approvals.md)).
11. **Settings and flags** (optional): what administrators change at
    runtime (`<x>-settings.ts`, `defineSettings()` with `setting()` and
    `flag()`, passed to `PlatformModule.forRoot({ settings })`); read with
    `settings.get(DECLARATION, principal)` ([settings.md](settings.md)).
12. **Background**: anything slow goes to a queue worker, never in the
   request: queues in `PlatformModule.forRoot({ queues })`, webhook events
   in `eventTypes`, a `DataExporter`/`DataImporter` for bulk moves (its
   timestamp columns `type: 'datetime'`: exported in the reader's zone; the
   importer's schema and `write()` reuse the create route's schema and
   service call, so an imported row is checked as a `POST` is).
13. **Environment** (`<x>.env.ts`): a Zod schema merged in `apps/api/src/features/env.ts`, a
    line in `env.example` and in docs/configuration.md.
14. **Texts**: messages in `apps/api/src/i18n/<locale>/<x>.json` for every locale,
    typed in `translations.ts`.
15. **Tests** (`apps/api/test/<x>.e2e-spec.ts`, see `apps/api/test/support.ts`): the routes,
    permissions (403s, what lists hide), validation (400s), the list's
    filters and sorts; then `pnpm build && pnpm lint && pnpm test &&
    pnpm test:e2e`, and `pnpm db:check` after table changes.
16. **Docs**: a row in the README's table when it's a tool of the template;
    docs/api-conventions.md only if it adds a convention.

## Starting a real project

Rename it (`name` in the root `package.json` and the `@nestjs-monorepo-template/`
scope of the packages, `API_TITLE` in `apps/api/src/openapi.ts`,
`API_KEY_PREFIX`), then delete `features/notes/` and its lines in
`features/index.ts`, `features/tables.ts` and `features/env.ts`,
`apps/api/test/notes.e2e-spec.ts`, and run
`pnpm db:generate`.
