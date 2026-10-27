# Exports and imports

Any data, as CSV, JSON or Excel, on the workers. A feature implements a
`DataExporter`, a `DataImporter`, or both (`features/notes/note.transfer.ts`):

```ts
@Injectable()
export class NoteTransfer implements DataExporter<Note>, DataImporter<NoteRow> {
  readonly name = 'notes';
  readonly subject = 'Note';                    // needs Note.read / Note.create
  readonly columns = [{ key: 'id' }, { key: 'title' }, { key: 'createdAt', type: 'datetime' }];
  readonly filters = NOTE_LIST.schema;          // the list's own filters
  readonly schema = createNoteSchema.omit({ custom: true });  // POST's own schema

  constructor(…, registry: DataTransferRegistry) {
    registry.registerExporter(this);
    registry.registerImporter(this);
  }
  async *batches(principal, filters) { … yield rows (keyset, 1000 at a time) … }
  async write(principal, row) { await this.notes.create(principal, row); }  // as POST does
}
```

| Route                                                         | Does                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/data`                                                | what the caller may export and import; each import's columns and template link                                      |
| `GET /v1/data/imports/{name}/template?format=&timezone=`      | a file to fill: the columns, an example row                                                                         |
| `POST /v1/data/exports { name, format, filters, timezone? }`  | 202; the file lands in private storage                                                                              |
| `POST /v1/data/imports` (multipart: `name`, `file`, `dryRun`) | 202; every row is validated, valid rows written                                                                     |
| `GET /v1/data/transfers/{id}`                                 | progress, then the result: a signed link (30 min), counts, the error report; `createdAt`, `finishedAt`, `expiresAt` |
| `GET /v1/data/transfers?kind=&status=&limit=&cursor=`         | the caller's transfers in this tenant, newest first, each as the route above tells it                               |

- **Per tenant** ([tenancy](tenancy.md)): a transfer job names the tenant
  it was started in (`tenantId`, required by its type); the worker runs it
  there (`TenantWorkerHost`), with its principal checked again as a member
  of that tenant. Its files (the upload, the export, the error report) are
  under `tenants/<id>/transfers/`. `GET /v1/data/transfers/{id}` answers 404
  for another tenant's transfer, even the same person's.
- **The list** (`GET /v1/data/transfers`): the transfers the caller started
  in the current tenant (its scheduled reports' included, they run as their
  owner), exports and imports or one `kind`, newest first, by cursor
  (`limit` up to 100, `cursor` = the previous `nextCursor`, the last id;
  an unknown or expired one is a 400): `{ items, nextCursor }`. `?status=`
  keeps those `queued`, `running`, `completed` or `failed` (the `status`
  each item carries; any other word is a 400), with `kind` or alone. The
  filter skips jobs without dropping them from the index, so a filtered
  page may hold fewer than `limit` items, even none, while `nextCursor` is
  set (a page reads a bounded number of entries): follow it until it is
  null. Only the
  caller's own, whatever their permissions: the docs' model is that a
  transfer is its principal's alone (an administrator sees theirs only).
  Listed while BullMQ keeps the job (7 days after it ends). The index is a
  Redis sorted set per tenant and principal (`platform/queues/job-index.ts`,
  `tenant:<tid>:jobs:data-transfers[:<kind>]:<principal key>`), written
  before the job is queued, expiring with it; each item is read from its
  job and checked again (tenant, principal), and an entry whose job is gone
  is dropped. The account export is not listed (it is in no tenant):
  `GET /v1/account/exports` lists it ([auth.md](auth.md)), from an index
  under the account (`account:jobs:data-transfers:account:<principal key>`).
- **Each status** (the single route and the lists) says when it was
  started (`createdAt`), ended (`finishedAt`, null until then) and stops
  being kept (`expiresAt`: 7 days after it ended, `TRANSFER_KEPT_MS`).
- `GET /v1/data` is described in the OpenAPI document (`catalogSchema`), so
  the typed client types it.
- **The account export** (an exporter with `scope: 'account'`: `POST
/v1/account/export`) is the person's, across their tenants: queued with
  `tenantId: null`, run in no tenant (it reads each tenant in turn, as
  docs/tenancy.md says), filed under `accounts/<user id>/transfers/`, and
  shown to that user in any tenant or none. Users only, never while
  impersonating.
  A deactivated tenant gives only the membership row, none of its records.
- **An internal exporter** (`internal: true`) starts only from its own
  route, in code (`startExport(…, { internal: true })`): `POST
/v1/data/exports` answers 404 for it, the catalog and the scheduled
  reports leave it out. The operators' tenant export is one
  (`TenantTransfer`, `POST /v1/tenants/{id}/export`, which wants a recent
  sign-in: [tenancy](tenancy.md), "Exporting a tenant").

- A column marked `type: 'date'` (a day, `2026-10-15`) is a date cell in
  Excel, text in CSV and JSON; a date cell under a `date` column of the
  template (`z.iso.date()`, a `date` custom field) imports as its day.
- Times are written in the **reader's time zone**: the `timezone` asked
  for, else the user's own, else `APP_TIMEZONE`. Mark a column
  `type: 'datetime'`:
  - CSV and Excel, for people: local time, `2026-10-15 18:30:00`, under
    `createdAt (Asia/Dubai)`. Spreadsheets read it as a date (Excel gets a
    date cell); an offset would turn it into text. To the second in CSV.
  - JSON, for programs: ISO 8601 with the offset,
    `2026-10-15T18:30:00.000+04:00`.
  - Imports read a header `name (Zone)` as column `name`, its local times
    in that zone, handed to the schema as ISO 8601 UTC: an exported file
    imports back to the same moments.
- A record that takes `tags` and `transfer` exports a `tags` column: the
  tag names joined by `, ` (`Urgent, Q3`), loaded one query per batch. An
  import ignores a `tags` column (the schema doesn't name it; tags are set
  with `PUT /{path}/{id}/tags`), as for notes.
- An exporter never writes an **encrypted column** ([encryption.md](encryption.md))
  as it is stored: a column naming an encrypted property needs a `value` that
  decrypts it, else boot fails (`assertNoEncryptedColumns`). The `value` runs
  only after the exporter's own permission check.
- Exports apply **field-level permissions** (a user without `Note.body`
  gets no text, and filters on it are a 403 `field_forbidden`) and the
  caller's read filter.
- Text a spreadsheet would run as a formula (a cell starting with `=`, `+`,
  `-` or `@`: `=1+1`, a phone number `+63 912`) is written with a leading
  quote, `'+63 912`, in CSV and Excel; an import removes that quote, as
  Excel does, so an exported file imports back as it was.
- **Imports write in groups of 200** when an importer implements
  `writeMany(principal, rows, { matchOn })`; otherwise the processor calls
  `write()` row by row. A group-level 4xx rolls the group back and the
  processor retries each row alone, so one bad row does not refuse its
  neighbors. `dryRun=true` runs the schema and permission checks, writing
  nothing. File size and data-row limits are configurable in Settings (defaults 50 MiB and 1,000,000 rows); see [Import limits](import-limits.md). Files are recognized by their content.
- **Matched imports**: an importer may declare `matchKeys` (columns unique
  within the tenant). The caller may send `matchOn` with one of those exact
  keys; the key must be present in the file. Without it, imports insert as
  usual. With it, each key must find one existing record; missing records
  are refused, never inserted, and a repeated key refuses its later
  occurrence. Matching is tenant-scoped. Notes allow `id` and `number`;
  matched rows need update permission and the same record and field checks
  as a note update. The API does not choose a key for the caller.
- **Templates**: the columns the caller may set (forbidden fields left
  out), read from the importer's schema with `z.toJSONSchema`, required,
  limits, choices, `.meta({ example })` and `.describe()` included;
  `templateColumns(principal)` adds columns the schema doesn't name
  (custom fields). One example row, as an import reads it (date-times local
  to the reader, the zone in the header). The Excel one adds a Columns
  sheet in the request's language (`i18n/<locale>/transfer.json`) and a
  dropdown on every column with choices. Built in the request: two rows.
- The realtime connection hears `data.export-ready` and
  `data.import-finished`. Both are audited; the principal is checked again
  when the job runs. While it runs: `data.progress { id, name, kind,
processed }` (an import also `imported`, `failed`; an export's at most once
  a second, an import's every 500 rows). When it fails for good (the handler
  throws on its last attempt, or BullMQ fails a stalled job):
  `data.failed { id, name, kind, error }`, sent from the worker's `failed`
  event, so the transfer already reads `failed`. `error` is a reason for
  people (a `TransferRefused` message: the account gone, unknown columns,
  too many errors, a foreign upload), else a generic one; the raw error stays
  in the logs and in `registry.onFinished` listeners. A page needs no poll
  for these.
- Code that starts a transfer and acts on its end (scheduled reports mail
  the file): `startExport(principal, { …, tag: 'report:<id>' })`, and
  `registry.onFinished(listener)` from a constructor; the listener hears
  every transfer that completes or fails for good, on the worker, and
  picks its own by `job.tag`. Its errors are logged, never fail the transfer.
  A job BullMQ fails itself (stalled past its limit, its worker gone) is
  heard too: the worker that applies that failure tells the listeners
  (`DataTransferProcessor.onFailed`).
- Columns or rows that change at runtime: `columnsFor(principal)` and
  `schemaFor(principal)`, read when the job starts, replace `columns` and
  `schema`; a column's `value(row)` reads a cell that isn't `row[key]`.
  `refusedColumns(principal, headers)` names the file's columns no row
  could pass (a custom field that no longer exists): checked once on the
  headers, the import fails with `Unknown columns: …` instead of refusing
  every row. Notes use them for [custom fields](custom-fields.md)
  (`custom.<key>`).
- Imports aren't retried automatically: a retry could write rows twice.
  Make `write()` idempotent (an upsert on a natural key) to allow it.
- Excel through exceljs (4.4, last released Dec 2024): exports stream;
  imports read the workbook whole (exceljs' streaming reader fails on some
  valid files) after a check of the zip's declared size. CSV imports stream
  (csv-parse); a JSON import is read whole. The libraries are used only in
  `formats.ts`.
