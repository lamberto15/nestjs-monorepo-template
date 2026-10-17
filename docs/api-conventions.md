# API conventions

The same rules on every route, so a client learns them once.

## Versions

Every route is under `/v1` (URI versioning). A breaking change ships as `/v2`
next to it: `@Version('2')` on a route, or `@Controller({ version: '2' })`.
`/health`, `/files` and the docs (`/api`) have no version.

## Errors: RFC 9457 problem details

Every error, whatever produced it, is `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request is invalid.",
  "code": "validation_failed",
  "errors": [{ "path": "email", "message": "email must be an email address" }],
  "instance": "/v1/auth/sign-in",
  "requestId": "0199a3f2-…"
}
```

- `code` is stable and machine-readable: `validation_failed`, `unauthorized`,
  `forbidden`, `field_forbidden`, `not_found`, `conflict`, `rate_limited`,
  `mfa_required`, `password_breached` (a new password found in data
  breaches, 400 with the field in `errors`), `reauthentication_required`
  (403 on a sensitive route: no sign-in in the last
  `REAUTHENTICATION_MAX_AGE_MINUTES`; the problem's `methods` say how to
  re-authenticate, then retry: [auth.md](auth.md), "Step-up"),
  `reauthentication_failed` (403: a wrong password or code to
  `POST /v1/auth/reauthenticate`), `reauthentication_unavailable` (409: the
  account has nothing to re-authenticate with in place: sign in again),
  `captcha_required` and `captcha_invalid` (403 on sign-in, sign-up, the
  magic-link request and forgot password: solve the challenge and send its
  token in `X-Captcha-Token`; the problem names `provider`, `siteKey` and
  `action`, a refusal its `reason`), `captcha_unavailable` (503, fail-closed
  only: the provider can't be asked; [auth.md](auth.md#bot-protection))…
  Branch on it, not on `detail`.
- `detail` and `errors[].message` are in the request's language.
- A 500 never shows internals; `requestId` finds it in the logs.
- In code: throw Nest's exceptions (`new ConflictException('…')`, or an object
  with `code` and extra fields). A package's own errors are mapped once:
  `ProblemDetailsFilter.map(SomeError, (e) => new HttpException(…))`.

## Validation

Zod schemas on the route: `@Body({ schema })`, `@Query({ schema })`. They
validate, convert (dates, numbers), and document the route in OpenAPI.
Response schemas use `z.iso.datetime()`, never `z.date()`.

**Body size.** A JSON body over 100 KB (`JSON_BODY_LIMIT`,
`core/http/body-limit.ts`) is refused before validation: 413
`payload_too_large`. A byte count isn't something a form can check, so every
text field carries its own `maxLength` in the schema, under the limit: a
record's `field.string()` 200 and `field.text()` 10 000 characters by
default, `max` up to `MAX_TEXT_LENGTH` (30 000, which fits the limit in any
script); a larger one is refused when the declaration loads. Validate the
fields against the OpenAPI document and the body fits.

## Resources

Every resource has the same shape and the same routes:

- **Fields:** `id` (a UUIDv7), `createdAt` and `updatedAt` (ISO 8601, UTC),
  then its own fields in camelCase; `custom` holds its custom fields' values
  when it has any. Never its tenant: that is the request's own (the session's
  or the key's, `GET /v1/auth/me`'s `tenant`, [tenancy](tenancy.md)). The
  response is its schema, no more.
- **What you may do with it:** `?include=can` on `GET /v1/<x>/{id}` and on
  the list adds `can` to each record, `{ update, delete, restore }` (restore
  with a recycle bin): what its routes would answer you now, by your
  permissions and their conditions (a published note is no longer an
  editor's to change: `update: false`, the PATCH a 403). `restore` is true
  only for a record in the bin you may restore. Left out by default, so lists
  stay light; `fields=` never removes it; another `include` value is a 400.
  It is about you, not the record: the ETag leaves it out (below). See
  [permissions](permissions.md), "Checking".
- **Routes:** `GET /v1/<x>` (a list), `GET /v1/<x>/{id}`, `POST /v1/<x>`
  (201, with `Idempotency-Key`), `PATCH /v1/<x>/{id}` (only what's sent
  changes; `null` clears), `DELETE /v1/<x>/{id}` (204); actions as
  `POST /v1/<x>/{id}/<verb>`.
- **Recycle bin** (soft-deletable resources, such as notes): `DELETE` moves
  the record to the bin, where no list, count, export or route sees it;
  `GET /v1/<x>?deleted=true` lists the bin and `POST /v1/<x>/{id}/restore`
  brings one back, both for those with the `restore` permission. Records
  carry `deletedAt` and `deletedBy`; the bin is emptied after
  SOFT_DELETE_RETENTION_DAYS (30).
- **Syncing:** every paginated entity list (notes, users, and each new
  feature's) filters and sorts by `updatedAt`, so a client
  fetches what changed since its last sync with
  `?updatedAt.gte=<last sync>&sort=updatedAt`.

## Collections

Every list answers `{ items }`. Lists that grow page by cursor:

```
GET /v1/notes?limit=50                         → { items, nextCursor }
GET /v1/notes?limit=50&cursor=<nextCursor>     → the next page; nextCursor null: the end
```

Newest first. Ids are UUIDv7 (time-ordered), so the cursor is the last id:
no offsets, stable while rows are added. With a `sort`, the cursor is
opaque (the last row's sort values and id, encrypted and authenticated by
the server with `CURSOR_KEYS`: keyset pagination, as cheap on page 1,000 as
on page 1); pass it back unchanged with the same `sort`, or it is a 400.
Clients can't read it: it may hold values of fields they can't see.

Screens that jump to a page number ask by number instead:

```
GET /v1/notes?page=3&limit=20&count=true       → { items, page: 3, nextPage: 4, total: 128, pageCount: 7 }
```

`page` and `cursor` are two ways to page: send one. A page may not start
past row 10,000 (`COUNT_CAP`): offsets read the rows they skip, so deep pages
are refused rather than slow (narrow the filters). Rows added between two
requests can shift a row to the next page; feeds and syncs use the cursor.

A total, when a screen shows one ("128 notes"), is asked for:

```
GET /v1/notes?count=true&status=draft          → { items, nextCursor, total: 128, totalCapped: false }
```

- It counts what the filters match and the caller may see, on every page
  the same (the cursor doesn't change it). Ask on the first page and keep it.
- Counting stops at 10,000 (`COUNT_CAP`): past it, `total: 10000,
  totalCapped: true`, shown as "10,000+". A large table never makes a list slow.
- Without `count=true`, nothing is counted: infinite scroll, syncs and
  exports pay nothing.

In code: `countPage(db, table, where, query)` next to the page's query, and
`toPage(rows, query, total)`; `where` is the filters and the read filter,
without the cursor (`NotesService.findPage`). A list may pass its own cap.

## Filters

Each list declares what it may be filtered by: fields, and per field the
operators (`listQuery()`). Anything else is a 400 naming it; values are
checked by the field's type. Each route's parameters in `/api` list its
fields and operators.

**Hidden fields can't be filtered, searched, sorted or selected.** A field
your field-level permissions hide on every record (docs/permissions.md)
is a 403 `field_forbidden` naming it (`fields: ["body"]`) wherever the
query uses it: a flat filter, a condition of `filter` at any depth,
`sort`, `fields`, and `q` / `sort=-rank` when the search document holds
it; `custom.<key>` counts as `custom`, a money field's `<x>Currency` as
`<x>`. The same for the filters of an export, a bulk run and a scheduled
report. `GET /v1/lists/{subject}` already leaves those out (and says
`search: false`).

| Operator | Means | Flat value | `filter` value |
| --- | --- | --- | --- |
| `eq`, `ne` | equal, not equal | `draft` | `"draft"`, `3`, `true` |
| `in`, `notIn` | one of, none of | `draft,published` | `["draft", "published"]` |
| `contains`, `notContains`, `startsWith`, `endsWith` | text, case-insensitive | `report` | `"report"` |
| `gt`, `gte`, `lt`, `lte` | compare | `2026-01-01T00:00:00Z` | `"2026-01-01T00:00:00Z"`, `10` |
| `between` | both ends included | `1,10` | `[1, 10]` |
| `isNull` | no value (`false`: has one) | `true` | `true` (the default) |

Dates are ISO 8601 with an offset (`Z` or `+04:00`), numbers and booleans
are JSON's own in `filter`. `%` and `_` are searched for as characters.

The flat syntax, for simple cases, one key per condition, all ANDed:

```
?status=draft                    eq
?status.in=draft,published
?title.contains=report
?createdAt.gte=2026-01-01T00:00:00Z&createdAt.lt=2026-02-01T00:00:00Z
?publishedAt.isNull=true
```

`?filter=` for the rest: JSON, a condition `{ "field", "op", "value" }` or a
group `{ "and": [...] }` / `{ "or": [...] }`, groups nested at most 3 deep,
30 conditions at most (URL-encode it):

```json
{
  "and": [
    { "field": "status", "op": "in", "value": ["draft", "published"] },
    {
      "or": [
        { "field": "title", "op": "contains", "value": "report" },
        { "field": "createdAt", "op": "gte", "value": "2026-01-01T00:00:00Z" }
      ]
    }
  ]
}
```

The flat filters and `filter` are ANDed. What the caller may see is ANDed
outside all of it: an `or` narrows or widens the filter, never the
caller's permissions.

## Search

A searchable list takes `?q=` (`core/database/search.ts`): words match
anywhere in the record's text, `"quoted words"` as a phrase, `-word`
excludes, `or` between words; `?sort=-rank` puts the best match first
(`rank` is a sortable field of such lists, 0 without `q`). PostgreSQL's
full-text search, on a generated `tsvector` column with a GIN index; the
`simple` configuration (every language, no stemming).

`GET /v1/search?q=…[&subject=Note&limit=20]` searches every kind of record
the caller may read at once: `{ subject, id, title, snippet, score, link }`,
best first; the snippet marks matches with `<b>…</b>` and is null for a text
the caller may not read. A text the caller may read on no record isn't
matched at all (only the rest of the record's text, without the index);
on a list, `q` is then a 403 (Filters, above). A feature joins by registering a `SearchSource`
(`features/notes/note.search.ts`).

## Sorting

`?sort=-createdAt,title`: declared sortable fields, comma-separated, `-`
for descending, at most 3. Ties go to the newest (the id), so the order is
total. A value missing (NULL) sorts as the largest: last ascending, first
descending. Without `sort`: newest first.

## Fields

`?fields=title,status`: each item has only these, and `id` always. Only
the list's own fields; field-level permissions apply first, so a field
your permissions hide stays hidden when asked for.

## List metadata

`GET /v1/lists/{subject}` (`Note`, `Invoice`…) describes a list at runtime,
so a generic table builds its filter menus, sort and column pickers without
repeating the declaration:

```json
{
  "subject": "Note",
  "fields": [
    { "name": "status", "type": "enum", "options": ["draft", "published"],
      "operators": ["eq", "ne", "in", "notIn"], "sortable": true, "custom": false },
    { "name": "custom.region", "type": "enum", "options": ["eu", "us"],
      "operators": ["eq", "ne", "in", "notIn", "isNull"], "sortable": true,
      "custom": true, "label": "Region" }
  ],
  "select": ["title", "status", "body", "custom", "custom.region"],
  "search": true,
  "recycleBin": false,
  "defaultSort": "-createdAt",
  "limits": { "defaultLimit": 50, "maxLimit": 100, "maxOffset": 10000, "countCap": 10000,
              "maxSort": 3, "maxConditions": 30, "maxDepth": 3, "maxValues": 50 }
}
```

- It is read from the list's own declaration (`<item>.list.ts`,
  `listQuery()`), the one the list route validates with, so the two can't
  drift. `fields` are what may be filtered (`operators`, the table above;
  empty: sort only) or sorted; `select` what `fields=` may pick (a field
  neither filterable nor sortable is only there); `search: true` means `q=`
  and `sort=-rank`; `recycleBin`, that `deleted=true` lists the bin for
  this caller.
- **Custom fields:** the caller's tenant's active ones (`custom.<key>`,
  `custom: true`, their `label`), as the list takes them now; never another
  tenant's.
- **Permissions:** for whoever may read the subject (the list route's
  permission), else 403; an unknown subject is a 404 (`not_found`). A field
  the caller may read on no record (field-level permissions) is left out of
  `fields` and `select`, `custom.*` with `custom`. One they may read on
  some records only (a grant with conditions) stays in `fields` with
  `operators: []` and `sortable: false`, and in `select`; `search` is
  false when `q` reads one. The list route refuses the same (403
  `field_forbidden`).
- Every feature has it: a generated record registers its list through
  `recordParts()`; a hand-written list adds `listSource('<Subject>', LIST)`
  to its module's providers (notes does; `platform/lists`).

## Using it from a data table

A table UI keeps its state its own way and maps it to these parameters.
For example a [tablecn](https://github.com/sadmann7/tablecn) data table
(TanStack Table): its filter items `{ id, operator, value }` become
conditions, its join operator the group, its sorting `[{ id, desc }]` the
`sort`, its visible columns `fields`, and its pagination `page` + `limit`
with `count=true` for the page count.

```ts
const OPS = { iLike: 'contains', notILike: 'notContains', eq: 'eq', ne: 'ne',
  inArray: 'in', notInArray: 'notIn', lt: 'lt', lte: 'lte', gt: 'gt',
  gte: 'gte', isBetween: 'between', isEmpty: 'isNull', isNotEmpty: 'isNull' };

function listParams(state: DataTableQuery, visible: string[]) {
  const conditions = state.filters.map((f) => ({
    field: f.id,
    op: OPS[f.operator],
    value: f.operator === 'isEmpty' ? true : f.operator === 'isNotEmpty' ? false
      : f.variant === 'number' || f.variant === 'range' ? toNumbers(f.value)
      : f.variant === 'date' || f.variant === 'dateRange' ? toIsoDates(f.value)
      : f.value,
  }));
  return new URLSearchParams({
    page: String(state.page),
    limit: String(state.perPage),
    count: 'true', // pageCount = response.pageCount
    fields: visible.join(','),
    ...(conditions.length && {
      filter: JSON.stringify({ [state.joinOperator]: conditions }),
    }),
    ...(state.sorting.length && {
      sort: state.sorting.map((s) => (s.desc ? '-' : '') + s.id).join(','),
    }),
  });
}
```

A date the table means as a whole day (`2026-01-31`, or "relative to
today") is a range the client computes: `gte` its local midnight and `lt`
the next one, as instants, so the day is the user's, not the server's.

## Concurrency and caching

Routes that return a record (or a list) send an `ETag`: a strong tag of
the representation, with `Cache-Control: private, no-cache`.

- Read again with `If-None-Match: <etag>`: 304 and no body while nothing
  changed. A list's tag changes when any row of the page does.
- Write with `If-Match: <etag>` (`PATCH`, `DELETE`): 412 `precondition_failed`
  if the record changed since you read it; read it again and retry. The
  problem's `etag` is the current one. Without `If-Match` the write goes
  ahead; `*` means the same. A write's response carries the new tag, and so
  does a create (201) and a restore: the tag `GET /{id}` would send, so the
  next write's `If-Match` needs no read first. Every one is strong.
- Tags are per reader: a field you may not see is not in yours.
- A record's `can` (`?include=can`) is not in its tag: the tag of
  `GET /{id}?include=can` is the plain `GET`'s, good as `If-Match`. A
  `304` may then keep a `can` from before a change to your roles (never
  from before a change to the record); the routes decide regardless.

For a feature: `@Etag()` on the route, `assertUnchanged(ifMatch, shown)` in
a write before the service call, with the record as that caller reads it
(`apps/api/src/core/http/etag.ts`; notes is the example). A key the tag
must leave out is marked `untagged(value, ['key'])` (`withCan()` does it
for `can`).

## Idempotency

Writes that must not happen twice take `Idempotency-Key: <a unique key>` (a
UUID is the safe choice; `@Idempotent()`): a retry with the same key gets the
first response. A key is spent even when that first answer was an error (a
400 included): send a corrected request with a new key. Its errors come from
`@nestjs/idempotency` with its own codes (`IDEMPOTENCY_KEY_REQUIRED`,
`IDEMPOTENCY_KEY_REUSED`: 422 for the same key with another body).
`IDEMPOTENCY` sets the deployment's mode. `required` (the default): a route
marked `@Idempotent()` refuses a request without the header (400
`IDEMPOTENCY_KEY_REQUIRED`). `optional`: a key is honoured when sent (replay;
422 for another body) but not demanded, so simple clients can create without
keys, at the price of no duplicate protection for a client that sends none.
The module-level default (`IdempotencyModule`'s `required`, set from the
variable) rules every `@Idempotent({ scope })`; a route that must stay
optional in both modes says `@Idempotent({ required: false })` (webhook
endpoints, reports, suppressions), and one that must always demand a key
would say `required: true`. The OpenAPI document follows the mode: the
decorators document the header as required, and under `optional`
`buildOpenApiDocument` marks every `Idempotency-Key` parameter optional
(`applyIdempotencyMode`). The committed typed client is generated with the
default mode.

**Per feature.** A record declaration (`<item>.record.ts`) may choose its
own: `idempotency: 'required'` (a payment: a missing key is a 400 whatever
`IDEMPOTENCY` says), `'optional'` (honoured when sent) or `'off'` (the
routes take no key and the document has no header); no line follows the
deployment. It rules the record's create and its platform write routes
(bulk, PDF), through `@RecordIdempotent(RECORD)`, which merges
`required` over the module's default per route; the document keeps an
explicit choice (the header is marked, then the marker is removed by
`applyIdempotencyMode`) instead of rewriting it to the deployment's mode.

Keys are the caller's own, **in its tenant**: the scope is
`tenant:<tenantId>:<user|client>:<id>` ([tenancy](tenancy.md)), so two
callers never replay each other's responses, and neither does one person
in two tenants (a key sent in tenant B never returns what was done in
tenant A); a user acting in no tenant has an `account:` scope of their own.

## Credentials

| Who | How |
| --- | --- |
| A browser | the session cookie (`__Host-sid`), from `POST /v1/auth/sign-in` |
| A mobile app or CLI | `Authorization: Bearer <JWT>`, from `POST /v1/auth/token` |
| A system | `Authorization: Bearer sk_<id>_<secret>`, an API client's key |

Writes from other websites' pages are refused (CSRF), except from
`CORS_ORIGINS`. A browser app on one of them may read these response
headers (`Access-Control-Expose-Headers`, `CORS_EXPOSED_HEADERS` in
`core/http/http-setup.ts`): `X-Request-Id`, `Retry-After`,
`Content-Language`, `ETag`, `Location` and `Idempotent-Replayed`.

## Rate limits

600 requests a minute per IP. Routes that take credentials are tighter, per
15 minutes:

| Limit | Routes |
| --- | --- |
| 5 | sign-in, sign-up, forgot password, change password, `POST /v1/auth/token`, magic link, re-authenticate |
| 10 | reset password, magic-link verify, MFA verify, email verify |
| 3 | resend verification |

Token refresh: 60 a minute. When the body has an `email`, the key is the
email and the IP; otherwise the IP alone. Over the limit: 429 `rate_limited`.

Sign-in, sign-up, the magic-link request and forgot password may also want
a challenge token in `X-Captcha-Token` (403 `captcha_required`), always or
after a few failed attempts: [auth.md](auth.md#bot-protection). While the
provider is down and the policy is fail-open, those routes allow
`CAPTCHA_DEGRADED_LIMIT` unverified requests per address in the window, then
429 `rate_limited`.

An API client with a daily quota gets `X-Quota-Limit` and `X-Quota-Remaining`
on every response, and past it 429 `quota_exceeded` with `X-Quota-Reset`
(seconds to midnight UTC) ([usage.md](usage.md)).

## Languages and time

`?lang=`, `X-Lang`, the user's saved language, then `Accept-Language`; the
answer's `Content-Language` says which. Dates in requests and responses are
ISO 8601, in UTC.
