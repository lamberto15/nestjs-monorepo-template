# Adding a feature

Every feature is built the same way, so the API is uniform for its clients
and the code for whoever reads it. Check the NestJS docs and the installed
`@nestjs/*` packages first: use what they offer before writing it.

## Start with the generator

```bash
pnpm feature:add invoices --fields "title:string,total:money,dueOn:date?,status:enum(draft|sent|paid)"
pnpm db:generate        # its table's migration (new tables: drizzle-kit asks nothing)
pnpm client:generate    # the typed client
```

It writes the feature's **record declaration**, `<item>.record.ts`: its
fields (platform/fields), its capabilities, its recycle bin (`softDelete`)
and teams (`team`), in one place. Everything else is derived from it by the
platform, so only the business logic is left to write (`<x>.service.ts`,
where it says "Business logic"):

- the table (`recordTable`: tenant, owner, team, the fields' columns, timestamps,
  recycle bin, search vector, indexes and keys), the schemas
  (`recordSchemas`), the list's filters and sorts (`recordList`);
- the capabilities' routes and targets (`recordParts` in the module: the
  platform's generic targets, platform/records), its list's description at
  `GET /v1/lists/<Subject>` (api-conventions.md, "List metadata"), the recycle bin's
  `POST /<x>/{id}/restore` (with `softDelete`), what the service does for
  them (`RecordLifecycle`: watchers, revisions) and how records are shown
  (`RecordPresenter`: money as objects, tags, field-level redaction);
- what the recycle bin and teams change: the service's reads, deletes,
  restores and a new record's team (`RecordStore`), the permissions
  (`recordPermissions`: `mine`, with `team` `inMyTeams` and the `team-lead`
  grant, with `softDelete` the `restore` action; added to the `editor`,
  `team-lead` and `viewer` seed roles, which merge across features), the
  policy (`RecordPolicy`), the resource (`recordResource`), the delete
  route's text and the e2e tests of both (test/record-capabilities.ts);
- the files it writes around that, the same whatever the flags say: the
  permissions and the policy (a line each, the feature's own rules added
  there), the audited service, the controller (idempotent create as the declaration says, ETags,
  If-Match, field checks), the module, `<x>.feature.ts` and
  `test/<x>.e2e-spec.ts` (bodies from the declaration).

It appends the feature to `features/index.ts`, `features/tables.ts` and the
OpenAPI test's path list.

```ts
// features/invoices/invoice.record.ts
export const INVOICE = defineRecord({
  subject: 'Invoice', path: 'invoices', apiTag: 'invoices', className: 'Invoice',
  noun: 'invoice', table: 'invoices', softDelete: true, team: false,
  clientAccess: false, grants: 'standard',   // idempotency: unset, the deployment's
  fields: {
    title: field.string().searchable(),
    total: field.money(),
    dueOn: field.date().optional(),
    status: field.enum(['draft', 'sent', 'paid']).default('draft'),
  },
  capabilities: ['tags', 'comments'],
});
```

- **Field types:** `string`, `text`, `int`, `decimal`, `money` (minor units and
  currency, `{ amount, currency }` in the API: [money](money.md)), `bool`,
  `date`, `datetime`, `enum(a|b)`, `json`, `ref(<feature>)` (optional, named `<x>Id`, a key
  within the tenant; its list filter is `ref: '<Subject>'` in the list metadata). `?` makes a field optional, `!unique` (string, int)
  unique per tenant (a duplicate is a 409 `<x>_taken`). In the declaration:
  `.optional()`, `.unique()`, `.default(v)`, `.searchable()`.
- **Options:** `--team` (records carry their creator's team: `team: true`),
  `--no-soft-delete` (deleted for good, no recycle bin: `softDelete: false`),
  both changeable later in the declaration, `--singular <name>`
  (when it can't be derived: `people` → `--singular person`),
  `--description "…"` (the Swagger tag's).
- **Who may use it, and the Idempotency-Key:** three more choices, each a
  line of the declaration, derived by the platform (nothing of them in the
  feature's code), changeable later:

  | Flag | Declaration | Default |
  | --- | --- | --- |
  | `--client-access own` | `clientAccess: 'own'`: every API client creates, reads, changes and deletes the records it created | `clientAccess: false`: **denied**; a client reaches the feature only through a role an administrator grants it |
  | `--grants none` | `grants: 'none'`: the seed roles (editor, team lead, viewer) get nothing; only administrators until someone grants it | `grants: 'standard'`: editors their own, team leads their teams' (with `team`), viewers read all |
  | `--idempotency required\|optional\|off` | `idempotency: '…'`: the create route and the record's platform write routes (bulk, PDF) | unset (no line): follow the deployment's `IDEMPOTENCY` |

  `clientAccess` and `grants` are always written (`false`, `'standard'`);
  `idempotency` only when chosen. The notes example is hand-written and
  keeps granting its clients.
- **Capabilities (`--with a,b,…`, or `capabilities` in the declaration):** each
  is a platform module, wired by `recordParts` with a generic target;
  `recordParts(…, { override: { revisions: MyRevisions } })` replaces one
  (notes does, for its hand-written custom fields).

  | Capability | Routes and more |
  | --- | --- |
  | `tags` | `PUT /<x>/{id}/tags`, `?tag=` on the list, `tags` in responses |
  | `comments` | `/<x>/{id}/comments`, the `<item>.commented` notification (texts in every locale) |
  | `attachments` | `/<x>/{id}/attachments`, download and remove at `/v1/attachments/{id}` |
  | `revisions` | `/<x>/{id}/revisions` (list, one, diff, restore); a revision per create and update |
  | `pdf` | `POST /<x>/{id}/pdf` on the shared page (`documents/templates/record.html`), labels in `documents.json`; needs `attachments` |
  | `bulk` | `POST /<x>/bulk` (delete, update, restore) |
  | `watch` | `POST`/`DELETE /<x>/{id}/watch`; the owner watches from the start |
  | `search` | a search vector over the `.searchable()` fields: `?q=` on the list, GET /v1/search |
  | `transfer` | exports (CSV, JSON, Excel), imports (when no required money or JSON field), the owner's data export |
  | `custom` | administrators' runtime fields ([custom fields](custom-fields.md)): `custom` in bodies and responses, `custom.<key>` in lists, exports and imports, snapshots and the audit; the `custom` column and its GIN index (run `pnpm db:generate`), the field-level `custom` permission |
  | `events` | webhooks `<item>.created`, `.updated`, `.deleted` (and `.restored` with a recycle bin), declared as event types and sent in the write's transaction through the outbox |
  | `numbered` | a gapless `number` per tenant (`INV-2026-00042`), set on create: in responses, filterable and sortable (`?number=`, `?sort=number`), in the PDF and exports; read-only; administrators' naming series replace the declared format ([sequences](sequences.md), "Naming series") |

  `events`: the data of each webhook is the record as the API shows it
  (less the fields its receiver may not read), sent to the API client that
  owns the record (endpoints belong to clients, so a user's records send
  none: [webhooks](webhooks-and-realtime.md)); it needs no endpoint to
  exist. `numbered`: the format is the declaration's `number: { prefix: 'INV',
  perYear: true, width: 5 }` (default: the subject's initials, per year, 5
  digits; one counter per tenant, [sequences](sequences.md)); the column is
  nullable, so the capability can be added to a table with rows (those
  records stay without a number). Both are done by `RecordLifecycle`, so the
  generated service changes with neither.

  Texts go to every locale of the API in English (each locale's plural
  forms); the command lists the keys to translate. Generated texts start in
  English in every language: translate the `de`, `ar`, `zh` and `ms` values by
  hand, keeping keys, `{{placeholders}}` and plural suffixes
  (`apps/api/src/i18n/catalogs.spec.ts` checks them), and have a native
  speaker review the result. The command writes the API's catalogs only: the
  web app's `locales/<lng>/<name>.json` are part of the web page you write by
  hand (docs/monorepo.md, "Adding a page for a feature"), checked by
  `apps/web/src/locales.test.ts`.

- **Approvals (`--approvals publish,markPaid`, or `approvals` in the
  declaration)** and **settings (`--settings "paymentDays:int=30,autoSend:flag"`,
  or `settings`)** are declared in the same file, one line each, and are
  not capabilities: they bring no table and no column, so no migration.

  ```ts
  approvals: {
    publish: { label: 'Publish an invoice' },
  },
  settings: {
    paymentDays: recordSetting.int(30).min(1).max(365),
    autoSend: recordSetting.flag(),
    tone: recordSetting.enum(['formal', 'casual'], 'formal'),
  },
  ```

  | Declared | The platform derives | The feature writes |
  | --- | --- | --- |
  | `approvals.<action>` | the approvable action `Invoice.publish` (default policy: one stage, decided by any user who may update the record, never the requester; an option `policy` replaces it, administrators store their own at runtime), its handler, the flag `invoices.publishApproval` (off by default, tenant and team scopes; `flag: false` makes approval always required), `POST /v1/invoices/{id}/publish` (200 `applied` at once, 202 `pending` with the approval's id; whoever may update the record asks), and the wait: while a request is open the record can't be changed or deleted (409 `approval_pending`; a delete withdraws a request sent back for changes) | what happens once approved (and at once when no approval is needed): an entry in `<item>.approvals.ts`, `apply({ id, actor, service })`, idempotent, as a workflow step |
  | `settings.<name>` | the setting or flag `invoices.paymentDays` (kinds `flag`, `int`, `string`, `enum`; `.min() .max() .label() .describe() .scopes([…]) .hidden()`), registered with the platform | reading it: `settings.get(recordSettings(INVOICE).paymentDays)` |

  `pnpm feature:add` writes the effects file and passes it to `recordParts()`
  in the module (`approvals: INVOICE_APPROVALS`); a missing entry for a
  declared action fails the build. A project can still declare approvals and
  settings by hand, as notes does ([approvals](approvals.md),
  [settings](settings.md)); the two ways may live side by side.

## Changing a feature

Edit its `<item>.record.ts`, then:

```bash
pnpm feature:sync      # texts (comments, pdf) in every locale, the OpenAPI test's paths, approvals' effects, the migration guard
pnpm db:generate       # when it says the table changes (review the SQL)
pnpm client:generate   # when it says the routes change
```

- **A field:** a line in `fields` (`reference: field.string().optional()`).
  The guard refuses a new **required** field without `.default(…)` (the
  migration would fail on a table with rows), an optional field made
  required, and a removed field: those follow expand/contract
  ([pitfalls](pitfalls.md)).
- **A capability:** its name in `capabilities` (search: mark the fields it
  searches `.searchable()`; pdf: with attachments; numbered: a
  `number: { prefix: 'INV' }` line for the format). Its routes, target and
  tests come with it: the feature's e2e spec runs
  `describeCapabilities(() => node, RECORD)` (test/record-capabilities.ts).
- **Removing a capability** takes its paths out of the OpenAPI test; its texts
  stay (harmless) until removed by hand.
- **An approval or a setting:** a line under `approvals` or `settings` (one
  per line, four spaces in). Sync adds the OpenAPI test's path for an action
  (run `pnpm client:generate`), appends a stub entry to `<item>.approvals.ts`
  (creating the file and wiring the module's `recordParts()` with the first
  action) and takes an entry out while it is still the stub; an entry with
  business logic in it is never touched: sync fails and says to move the
  logic and remove it by hand. Settings need nothing from sync. It warns
  when one is removed: open requests of a removed action can no longer be
  decided or applied (let them end first), and values administrators stored
  for a removed setting stay unread in the database.

- **The recycle bin or teams:** flip `softDelete` or `team`. Their code is
  the platform's (`RecordStore`, `recordPermissions`, `RecordPolicy`,
  `recordResource`, the restore route, the e2e tests), so nothing else
  changes by hand; sync moves the restore path in or out of the OpenAPI
  test. Turning one on adds nullable columns (`deleted_at`, `deleted_by`;
  `team_id` and its key: existing records get no team). Turning one off
  drops them, and the guard refuses it like a removed field: records in the
  recycle bin would come back as live ones, records lose their team; restore
  or purge them first, then expand/contract. The guard also fails on a
  generated file that still codes either by hand (one generated before they
  moved to the platform): bring it to the shape `pnpm feature:add` writes.
- **Who may use it:** `clientAccess` (`false` | `'own'`) and `grants`
  (`'standard'` | `'none'`) are read by `recordPermissions`; nothing else
  changes by hand and no migration is needed. API clients' permissions are
  code, so a change reaches every tenant on the next deploy; the seed
  roles' grants are written when a tenant is made, so **existing tenants
  keep the roles they have** (their administrators change them at
  `/v1/access/roles`) and only new tenants start with the new grants. Sync
  compares the declaration with the committed one and says so.
- **The Idempotency-Key:** `idempotency: 'required' | 'optional' | 'off'`,
  or no line to follow `IDEMPOTENCY`. The create route, bulk and the PDF
  route take it from the declaration (`@RecordIdempotent`; the OpenAPI
  document follows: an explicit `required` or `optional` wins over the
  deployment's mode, `off` has no header); sync fails on a controller that
  still codes `@Idempotent` by hand.
- `pnpm feature:sync --check` fails when anything is out of line (CI's
  feature-smoke job runs it after changing a feature this way).

- **Approvals and settings:** see the section below; both are generated
  from the declaration.
- **Not generated:** workflows and webhook events beyond the record's own
  changes (`events`): add them as the sections below say, notes as the
  example.
- **Adding seed roles to an existing database:** the roles are written when a
  tenant is made; an existing tenant's administrators grant the new
  permissions through the access API.

`apps/api/src/features/notes/` is the hand-written example of everything
this page describes, business logic included; the sections below are the
standard both follow.

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
  note-events.ts                        domain events (webhook, notification, realtime), the workflow signal
  note-settings.ts                      settings and flags
  note-ai.ts                            the AI helper's source
  note-publication.workflow.ts          the workflow
  note-publisher.service.ts             the workflow's steps (webhooks, realtime)
  note-approvals.ts                     publishing needs approval (the declaration, its handler)
  example-sender-webhook.controller.ts  an incoming webhook
```

Names: plural for the module, the tables, the environment, the service and
the controller (`notes.*`); singular for what describes one record
(`note.*`, `note-*`). Below, `<x>` is the plural, `<item>` the singular.

## The standard, step by step

1. **Table** (`<x>.tables.ts`; a number people quote: `NamingSeriesService.next()` on
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
   mistake; a generated feature's `softDelete: true` does all of this
   through the platform): the table spreads `...softDeletable()` (`deleted_at`,
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
     attachments keep their nightly sweep). A `.unique()` field of a record
     does it for you (the index is partial on live rows, a restore into a taken
     value is a 409 `<item>_taken`); a hand-written unique column of such a table needs a
     partial index (``.where(sql`deleted_at is null`)``), or a deleted record
     keeps its value taken.
   Not for link tables, logs, or records with a real "inactive" state (users
   and API clients deactivate). Notes is the example.
6. **Custom fields** (optional; a generated record takes them with the
   `custom` capability and none of this is written: the table, schemas,
   service step, presenter and the platform's declaration come from the
   record). By hand: a `custom` JSONB column with a GIN index,
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
   - The page (as `NotesService.findPage(user, list, query)`: the service
     composes the filters, the controller passes the parsed query and imports
     nothing from `drizzle-orm`, which oxlint enforces for `*.controller.ts`):
     `and(access.sqlFilter(…), list.where(query))`, ordered by `pageOrder(table.id, query)`,
     `.offset(pageOffset(query))`, `countPage()` beside it, `toPage()`.
     Then `access.redactAll()` on the items, and `list.pick(page, query)` last.
   - Described to clients at `GET /v1/lists/<Subject>` (filters, operators,
     sorts, custom fields: [api-conventions.md](api-conventions.md), "List
     metadata"): a generated record's comes with `recordParts()`; by hand,
     `listSource('<Subject>', LIST, CAPABILITIES)` among the module's
     providers (the capabilities its records take, for
     `GET /v1/lists/{subject}`).
   - With custom fields: `@Query() raw` + `@ApiListQuery(LIST, …)`, then
     `customFields.extendList(LIST, subject)`, `list.parse(raw)`, and
     `select({ ...getTableColumns(t), ...list.sortSelect(query) })`
     (`NotesController.list`). Without: `@Query({ schema: LIST.schema })`.
     Either way each parameter is typed from the list's schema
     (api-conventions.md, "Collections"): `ApiListQuery` adds nothing by hand.
   - With field-level permissions (declared `fields`), a hidden field
     can't be filtered, sorted, selected or searched, nor one shown on some
     records only be filtered, sorted or searched (docs/permissions.md).
     A generated controller gets that from its only way to a query,
     `const { list, query } = await this.presenter.query(user, LIST, raw)`
     (`RecordPresenter`: custom fields, validation, then
     `access.assertQueryFields()`). By hand, call
     `await access.assertQueryFields(user, '<Subject>', query)` right after
     the query validates (as `NotesController.list`). `searchFields(t.search,
     ['title', 'body'])` names the fields the vector is made of.
   - **A controller generated before this** calls `presenter.list(LIST)`
     and `list.parse(raw)`, which no longer compile (`presenter.list` is
     gone): replace those two lines with the `presenter.query()` call
     above.
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
    `@Etag()` on the routes that return the record (the create and the
    restore too), `assertUnchanged(ifMatch, shown)` before an update or
    delete ([api-conventions.md](api-conventions.md), "Concurrency and
    caching"); `?include=can` on the read and the list
    (`@Query('include', IncludePipe)`, `RecordPresenter.one(user, row,
    include)` and `.page()`; a hand-written feature calls `recordCan()` and
    `withIncluded()`, as notes does); with `watch`, `?include=watching`
    adds `watching` the same way (one query per page). A text field's `max` stays under
    `MAX_TEXT_LENGTH` (the body limit); the response never carries
    `tenantId`.
   - `@Can()` on the route, or a check on the loaded record; field-level
     checks on writes (`field_forbidden`). A route on one record finds it
     with `findOne(id, undefined, { visibleTo: user })`, so one the caller
     may not read is the 404 of a missing one; the action's check after it
     is the 403 ([permissions.md](permissions.md), "A record you may not read is a 404").
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
10. **Notifications** (optional): declare the types the feature sends, with
    the webhook and realtime events they go with, once
    (`<item>-events.ts`, `defineDomainEvents()`, passed as `defineFeature({ events })`;
    for a type with no other channel, `<x>-notifications.ts`,
    `defineNotifications()`, passed to `PlatformModule.forRoot({ notifications })`), their texts in
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
    The AI helper on its records: an `AiSource` (`<item>-ai.ts`) registered into
    `AiRegistry` ([ai.md](ai.md)). Rules that purge or anonymise old rows: a
    declaration registered into `RetentionRegistry` ([retention.md](retention.md)).
11. **Settings and flags** (optional): what administrators change at
    runtime (`<x>-settings.ts`, `defineSettings()` with `setting()` and
    `flag()`, passed to `PlatformModule.forRoot({ settings })`); read with
    `settings.get(DECLARATION, principal)` ([settings.md](settings.md)).
12. **Background**: anything slow goes to a queue worker, never in the
   request: queues in `PlatformModule.forRoot({ queues })`, webhook events
   in `eventTypes`, a `DataExporter`/`DataImporter` for bulk moves (its
   timestamp columns `type: 'datetime'`: exported in the reader's zone; the
   importer's schema and `write()` reuse the create route's schema and
   service call, so an imported row is checked as a `POST` is). The list
   page's Export and Schedule report buttons need no wiring: `ListPage` shows
   them when the catalog has an exporter for its subject, and the export
   follows the list's filter, search and sort ([data-transfer.md](data-transfer.md)).
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
`API_KEY_PREFIX`), then remove the example feature and its table:

```bash
pnpm feature:remove notes   # --dry-run shows what goes
pnpm db:generate
pnpm client:generate
```

`pnpm feature:remove <name>` removes any feature the same way: its folder,
its tests (`test/<name>.e2e-spec.ts`, `test/features/<name>/`), its lines in
`features/index.ts`, `tables.ts` and `env.ts`, its texts (the `<item>` key of
each locale's files), its PDF template, and its variables (the
`feature:<name> begin … end` blocks in `env.example`,
`apps/api/env.development.example` and `test/setup-env.ts`). In the web app
it takes the paths every feature's pages use (docs/monorepo.md, "Adding a page
for a feature"): `apps/web/src/features/<name>/` (its queries, forms, nav
entry and tests), `routes/_app/<name>/`, `locales/<lng>/<name>.json`, and its
names in the shared texts (`search.json`'s `subjects.<Subject>`,
`settings.json`'s `groups.<name>`, `approvals.json`'s `actions.<Subject>`).
The command regenerates `routeTree.gen.ts` itself (TanStack Router's
generator, the Vite plugin's), so no build is needed first. It refuses while
another feature refers to it, or another web file imports from its folder. On a live database, dropping a table is a
contract step: release the code that no longer uses it first
(docs/development.md, migrations).

Nothing else depends on a feature: the platform's own tests run on a
test-only record (`apps/api/test/fixtures/test-items`, made by the generator,
its migrations in `test/fixtures/drizzle`, `pnpm db:generate:fixtures`), and
CI checks it: every pull request removes notes and fails on a reference left
behind (`check`), and the `template-without-notes` job (nightly, tags) builds
and runs everything without them. The web app's shared tests do the same: they mount the shared
components alone (`renderComponent()`) on a test-only subject (`TestItem`),
and the tests of a feature's pages sit in its folder. A feature's own tests live in `test/<name>.e2e-spec.ts` or
`test/features/<name>/`, with their helpers next to them.

### A feature's demo data

`pnpm db:seed:demo` makes the demo tenant, its teams and users in the seed
roles (`editor`, `team-lead`, `viewer`: `iam/access/seed-roles.ts`; features
add their grants to them by key). A feature adds its own data with `demo` in
its `defineFeature()`: a provider of its module implementing
`FeatureDemoSeeder` (`seed(context)`: the transaction, the tenant, the demo
users by key) and the permissions it needs (`features/notes/notes.demo.ts`
is the example).
