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

| Route | Does |
| --- | --- |
| `GET /v1/data` | what the caller may export and import; each import's columns and template link |
| `GET /v1/data/imports/{name}/template?format=&timezone=` | a file to fill: the columns, an example row |
| `POST /v1/data/exports { name, format, filters, timezone? }` | 202; the file lands in private storage |
| `POST /v1/data/imports` (multipart: `name`, `file`, `dryRun`) | 202; every row is validated, valid rows written |
| `GET /v1/data/transfers/{id}` | progress, then the result: a signed link (30 min), counts, the error report; `createdAt`, `finishedAt`, `expiresAt` |
| `GET /v1/data/transfers?kind=&status=&limit=&cursor=` | the caller's transfers in this tenant, newest first, each as the route above tells it |

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
- Exports apply **field-level permissions** (a user without `Note.body`
  gets no text, and filters on it are a 403 `field_forbidden`) and the
  caller's read filter.
- Text a spreadsheet would run as a formula (a cell starting with `=`, `+`,
  `-` or `@`: `=1+1`, a phone number `+63 912`) is written with a leading
  quote, `'+63 912`, in CSV and Excel; an import removes that quote, as
  Excel does, so an exported file imports back as it was.
- **Each imported row is one `POST`** of the feature: the importer's schema
  (reuse the route's), then the field-level permissions (a field the caller
  may not set refuses the row, as `field_forbidden` would; an empty cell
  sets nothing), then `write()` with the same service call. Columns the
  schema doesn't name (`id`, `createdAt`: an export's) are ignored. A 4xx
  `write()` throws refuses that row alone (its `errors` / `fields` become
  the report's lines); anything else fails the import. Refused rows (row, field, message) come back as a CSV;
  `dryRun=true` runs the schema and permission checks, writing nothing.
  Files up to 50 MB, recognized by their content.
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
  when the job runs.
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
  valid files). The libraries are used only in `formats.ts`.
