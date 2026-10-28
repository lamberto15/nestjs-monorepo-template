# Saved views

A list's filters, sort, search and columns kept under a name: "My drafts",
"Overdue, newest first". Private to their owner, shared with an organizational unit, or
tenant-wide. `apps/api/src/platform/views/`. They work for every list
`GET /v1/lists/{subject}` describes ([api-conventions.md](api-conventions.md),
"List metadata"), so a feature does nothing to get them. Every web list page
(`ListPage`) has the view picker (below).

```http
POST /v1/views
{ "subject": "Note", "name": "My drafts", "visibility": "private",
  "query": { "status": "draft", "sort": "-createdAt" },
  "columns": ["title", "status", "createdAt"] }

GET /v1/views/{id}/apply
→ { "view": {…}, "params": { "status": "draft", "sort": "-createdAt", "fields": "title,status,createdAt" },
    "columns": ["title", "status", "createdAt"], "hiddenColumns": [] }

GET /v1/notes?status=draft&sort=-createdAt&fields=title,status,createdAt   # what `params` is
```

| Route                      | Does                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/views`            | the views you see: yours, those of your units, the tenant's, of the lists you may read; `?subject=`, `?visibility=`, `?unitId=`, `?name=`, `?name.contains=`, `?sort=name`; cursor pages, newest first |
| `POST /v1/views`           | save one (201, audited `view.created`)                                                                                                                                                                 |
| `GET /v1/views/{id}`       | one you see (another's private view, a unit's you are not in: 404)                                                                                                                                     |
| `GET /v1/views/{id}/apply` | the view checked again, as `params` for the list route (below)                                                                                                                                         |
| `PATCH /v1/views/{id}`     | only what is sent changes, never the `subject`; `view.updated`                                                                                                                                         |
| `DELETE /v1/views/{id}`    | 204; `view.deleted`                                                                                                                                                                                    |

Every response says `mine` (you own it) and `editable` (you may change it).

## What a view holds

- **`query`**: the list route's own parameters, as strings: flat filters
  (`status`, `title.contains`, `custom.region.in`), `filter` (the JSON tree
  as a string), `sort`, `q`. Never paging (`limit`, `cursor`, `page`,
  `count`), `fields`, `deleted` or `lang`: each is a 400 naming
  `query.<parameter>`.
- **`columns`**: item fields to show, in order, each one of the list's
  `select`. `null`: the list's own.
- **`visibility`**: `private` (default), `unit` (with `unitId`) or `tenant`. Only these three are accepted (a database check); migrate fails on a stored `team` ([releases](releases.md), "Upgrading across a removed rename").

## Validated on save and on apply

The query is parsed by the list declaration with the tenant's custom fields
as they are now (`ListsService.extended()`), as the list route would, so
the 400s name the same parameters. Then the viewer's field-level permissions
(`AccessService.assertQueryFields`): a filter, search or sort on a field
they may not read is a **403 `field_forbidden`**, since it would tell the
field's value. On apply the same checks run again for whoever applies it:

- a custom field deactivated since, or a list that changed, is a **400**
  naming `query.<parameter>` (the view is stale: change it);
- a **column** the viewer may not read is **left out**, not an error:
  `hiddenColumns` lists it, `columns` and `params.fields` lack it;
- a viewer who may not read the list sees no view of it (404 by id).

## Who may do what

- **Private**: anyone signed in, users and API clients. Names are unique per
  list and owner, whatever the case (409 `conflict`). At most 100 views per
  owner.
- **Unit**: a current member of the unit (`organizational_unit_memberships`,
  the unit itself, not those below it), or a holder of `Access.manageViews`.
  Seen by the unit's members. Deleting the unit deletes its views.
- **Tenant**: `Access.manageViews` only (users only, never while
  impersonating, like every Access action); seen by everyone who may read the
  list. Names are unique per list within the unit or tenant.
- **Changing or deleting**: the owner; a shared view also a holder of
  `Access.manageViews`, who may not make another's view private (it would
  vanish for everyone else) and never sees a private view or a unit's they are
  not in. Everyone else gets a 403 on a view they see.

## Account and data

Views are a `PersonalDataSource`: the owner's views are in their data export.
On **account deletion** their private views are deleted and their shared ones
stay, ownerless (`owner: "anonymous"`), changeable by view managers only. A
membership ended (a user deprovisioned from a tenant) leaves their shared
views in place; their private ones become unreachable with the account's
access to that tenant and go when the tenant or the account does.

The table `saved_views` is a tenant table behind row-level security
([tenancy.md](tenancy.md)); its `unit_id` is a composite key to `organizational_units`
(cascade). Audited like any record (`view.created`, `view.updated` with
what changed, `view.deleted`).

Not in this first version: views in the exports and scheduled reports
(`filters` of a report are the list's `query`, so a view's `query` can be
sent as an export's `filters`), a default view per user, ordering views.

## In the web app

`ListPage` shows a **Views** menu in its toolbar (`apps/web/src/features/views`).
It reads `GET /v1/views?subject=` when opened, grouped as private, the user's
units' and the tenant's. Choosing one calls `/apply` and sets the table from
its `params` (filters, join, sort, search) and `columns` (a view with none shows
the list's own); the filters, sort and search are the table's URL state, so the
page can be shared. `view-state.ts` turns `params` back into table filters (the
reverse of `listParams`); a filter the table has no control for is refused with a
toast, never shown wrong. "Save the current view" sends the `filter`, `sort` and
`q` of the list route and the visible columns, as private, for a unit, or
tenant-wide (only with `Access.manageViews`); the chosen view can be renamed or
deleted when `editable`. Refusals: a stale view (400, naming `query.<parameter>`)
and a forbidden field (403 `field_forbidden`) are toasts, a name taken (409) is on
the name field. Column order is not applied (the table keeps its own).

Tests: `apps/api/test/views.e2e-spec.ts`, `apps/web/src/features/views/`.

## Record views: board, calendar, timeline

A subject can offer its list besides the table as a **board** (a column per
value of an enum field, such as a status), a **calendar** (month, week and
agenda of date fields) and a **timeline** (bars from a start field to an end
field). They are declared, not computed: `views` in the record declaration
(`<item>.record.ts`), or `listSource(subject, list, capabilities, views)` in a
hand-written feature (notes does, `NOTE_VIEWS`); the names are fields of the
feature's `<item>.list.ts`, checked at startup (board: an enum; the others:
`date` or `datetime`).

```ts
views: {
  board: { field: 'status', readOnly: false },
  calendar: { fields: ['dueDate'] },
  timeline: { start: 'startsOn', end: 'dueDate' },
},
```

`GET /v1/lists/{subject}` answers them as `views` ([api-conventions](api-conventions.md),
"List metadata"), for this caller: a view whose field they may not read, or
may read on some records only, is left out, as is one whose field lacks the
operators its query needs (`eq`; `gte` and `lt`; for the timeline `lt` on the
start, `gte` and `isNull` on the end). There is no new route: every view reads
the list route and changes a record through its update route, so permissions,
tenant isolation, field-level redaction, validations and approvals are the
list's and the update's own. `readOnly` is for a feature whose update does not
change that field (notes: a status is published, not set).

In the web app `ListPage` shows a **Show as** switch beside the search when a
subject declares views (`?layout=board|calendar|timeline`, the table without it;
`features/record-views`). Each view starts from the table's own filters and
search (the table's `filter` and `q`, joined with the view's bounds) and shows
the cells of the columns left visible:

- **Board**: a column per option, each its own query, "Load more" growing it
  up to the list's `maxLimit`. A card moves from its menu (a button, so a
  keyboard and a phone reach it): the app reads the record for its ETag and
  sends `PATCH` with `If-Match`. The card moves at once and **goes back with a
  message** if the update is refused (403, 409, 412, validation, an approval
  that holds the change) or answers without changing the field. Only offered
  where the record's `can.update` is true and writes are not paused.
- **Calendar**: month, week or agenda, asking only for the visible range
  (`field gte start` and `field lt end`, one page of up to `maxLimit`, a notice
  when there are more). A `date` field is an **all-day** entry on its day; a
  `datetime` is on the day it falls on in the user's time zone, with its time,
  and the range is bounded by the zone's midnights (so a daylight-saving day
  is 23 or 25 hours long). Rescheduling is a dialog with a date input,
  validated (a real date, a different one); a moment keeps its time of day in
  the zone. The agenda is the list a keyboard and screen reader walk.
- **Timeline**: read-only bars in a window of days, weeks or months (zoom),
  asking for records that start before the window ends and end after it
  starts or have no end yet (drawn to the window's end). A record whose end
  is before its start is listed apart, not drawn. "Show as list" swaps the
  chart for a table of the same records, the accessible alternative.

Not in this version: **dependencies between records** (the issue's second
part: a relationship stored per record, its cycle check and arrows between
bars), drag and drop (moves and reschedules use buttons), several pages of
one calendar range, the views in saved views (a saved view keeps the table's
filters, sort and columns; the shown kind is the URL's `view`).
