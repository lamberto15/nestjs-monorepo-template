# Bulk operations

Act on many records of a feature at once: delete, restore, change. Each
item goes through the feature's own service call, as its route does it
(record and field-level checks, its transaction, its audit entry, its
webhooks); an item that fails does not stop the others. The capability is
`apps/api/src/platform/bulk/`; notes are the example (`features/notes/note.bulk.ts`).

## For clients

```http
POST /v1/notes/bulk
Idempotency-Key: 6f1c…
{ "action": "delete", "ids": ["0199…", "0199…"] }
```

| Field | Takes |
| --- | --- |
| `action` | one of the feature's actions (notes: `delete`, `restore`, `update`) |
| `ids` | 1 to 500 record ids (duplicates count once) |
| `filter` | the list's filters, as on its list route: `{ "status": "draft", "title.startsWith": "Old" }` (at least one; `limit`, `sort`, `deleted`… are refused: a run acts on every match) |
| `input` | what the action takes (notes' `update`: the PATCH body) |

Send `ids` or `filter`, one of them.

- **Small runs answer at once:** up to `BULK_SYNC_LIMIT` ids (100) →
  `200 { done, failed, skipped, results }`, one result per id, in the order
  sent:
  ```json
  { "done": 2, "failed": 1, "skipped": 1, "results": [
    { "id": "…", "status": "done" },
    { "id": "…", "status": "failed", "error": { "code": "field_forbidden", "message": "You may not change: body.", "errors": [{ "path": "body", "message": "…" }] } },
    { "id": "…", "status": "skipped", "error": { "code": "not_found", "message": "Not found, or not yours to delete." } }
  ] }
  ```
  `failed`: the problem the record's own route would have answered (its
  `code`, `message`, field `errors`). `skipped`: the id doesn't exist, or
  isn't yours to act on (the same answer for both, as a 404 would be).
- **Larger runs, and every `filter`, are a background job:**
  `202 { id, status: "queued" }`. Follow it at `GET /v1/bulk/{id}`:
  `{ id, name, action, status: queued|running|completed|failed, progress: { processed, done, failed }, result? }`
  (progress every 100 items; the result keeps 10 000 item results, its
  counts are exact, `truncated: true` when there were more). Only the
  principal who started it sees it (404 for anyone else). The realtime
  connection hears `bulk.finished { id, name, action, done, failed }`.
- **Idempotency-Key is required**: a retry with the same key gets the first
  answer back (`Idempotent-Replayed: true`) instead of acting twice.
- **Errors** (problem details): `validation_failed` (both or neither of
  `ids` and `filter`, an unknown action, a bad filter or input; `errors`
  names the path: `action`, `ids.3`, `filter.title.nope`, `input.title`),
  `bulk_too_many` (more than 500 ids: use a filter), `forbidden` (you may
  not do this action at all), the idempotency codes.
- A job is never retried, not even when its worker is lost mid-way (a
  redeploy): it fails with "Items done stay done"; the audit log says
  which, and a new run with the same selection does the rest (ids already
  done come back `skipped`).
- The principal is checked again when the job starts: a deactivated
  account gets nothing done.

## For features

Implement a `BulkOperation` and register it from its constructor
(`features/notes/note.bulk.ts`):

```ts
@Injectable()
export class NoteBulk implements BulkOperation<Note> {
  readonly name = 'notes';
  readonly subject = 'Note';                       // the permission subject
  readonly actions = {
    delete: { label: 'Delete', permission: 'delete' },
    restore: { label: 'Restore', permission: 'restore' },
    update: { label: 'Change', permission: 'update', input: updateNoteSchema },
  };
  readonly filters = NOTE_LIST.schema;             // the list's own filters

  constructor(…, registry: BulkRegistry) { registry.register(this); }

  /** The records the caller may `action`: in SQL, keyset batches by id. */
  async *select(principal, action, { ids, filter }) {
    const where = and(
      await this.access.sqlFilter(principal, 'Note', action, { deleted: action === 'restore' }),
      ids ? inArray(notes.id, ids) : NOTE_LIST.where(filter),
    );
    … yield rows (500 at a time, lt(notes.id, cursor)) …
  }

  /** One item, as the route does it; a 4xx fails this item alone. */
  async perform(principal, action, note, input, ip) {
    if (!(await this.access.can(principal, action, 'Note', note))) throw new ForbiddenException();
    … forbiddenFields → field_forbidden; this.notes.delete / restore / update(principal, note, input, ip) …
  }
}
```

and a route on the feature's controller, HTTP only:

```ts
@Post('bulk')
@HttpCode(HttpStatus.OK)
@Idempotent({ required: true, scope: principalScope })
@Can.Anyone()                                       // BulkService checks the permissions
@ApiHeader(idempotencyKeyHeader(true))
@ApiOkResponse({ standardSchema: bulkResultSchema })
@ApiAcceptedResponse({ standardSchema: bulkStartedSchema })
async runBulk(@CurrentUser() user, @Body({ schema: noteBulkSchema }) dto, @Ip() ip, @Res({ passthrough: true }) res) {
  const outcome = await this.bulk.run(user, { name: 'notes', ...dto, ip });
  if ('status' in outcome) res.status(HttpStatus.ACCEPTED);
  return outcome;
}
```

`noteBulkSchema = bulkRequestSchema(['delete', 'restore', 'update'], updateNoteSchema)`
documents the body. `BulkService.run()` does the rest:

1. The operation and the action exist (404 / 400); the caller has the
   action's permission on the subject at all (`access.can`), else 403.
2. `ids` (deduplicated, at most 500) or `filter` (parsed by `filters`),
   `input` parsed by the action's schema (none: it takes no input).
3. Up to `BULK_SYNC_LIMIT` ids: `select`, then `perform` each record in
   the request. More ids, or a filter: the `bulk` queue (concurrency 2, one
   attempt), the selection and input parsed again by the worker.
4. Audit: `bulk.started` (name, action, the number of ids or the filter)
   and `bulk.finished` (done, failed, skipped), target `bulk`/the run's id;
   each item has the feature's own entry (`note.deleted`).

Rules for an operation:

- `select` is the record-level check: yield only what the caller may act
  on (`access.sqlFilter` for the action's permission), never an offset
  (the action changes what matches; keyset by id).
- `perform` calls the same service method as the route, never a query of
  its own, and repeats the route's checks on the record (it may have changed
  since it was selected) and on the fields (`access.forbiddenFields`).
  Throw Nest's 4xx exceptions with a `code`: they become the item's error.
  Anything else (a 5xx, the database gone) stops the run.

**Tenancy** ([tenancy](tenancy.md)): a queued run names the tenant it was
started in (`tenantId`); the worker runs it there, as its principal checked
again as a member of it. Another tenant's run is a 404 at
`GET /v1/bulk/{id}`, even the same person's.
