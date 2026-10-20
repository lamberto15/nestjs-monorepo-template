# Saved views

A list's filters, sort, search and columns kept under a name: "My drafts",
"Overdue, newest first". Private to their owner, shared with a team, or
tenant-wide. `apps/api/src/platform/views/`. They work for every list
`GET /v1/lists/{subject}` describes ([api-conventions.md](api-conventions.md),
"List metadata"), so a feature does nothing to get them. The view picker in
the web list pages is a follow-up (a `frontend` issue); the API is complete.

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

| Route | Does |
| --- | --- |
| `GET /v1/views` | the views you see: yours, those of your teams, the tenant's, of the lists you may read; `?subject=`, `?visibility=`, `?teamId=`, `?name=`, `?name.contains=`, `?sort=name`; cursor pages, newest first |
| `POST /v1/views` | save one (201, audited `view.created`) |
| `GET /v1/views/{id}` | one you see (another's private view, a team's you are not in: 404) |
| `GET /v1/views/{id}/apply` | the view checked again, as `params` for the list route (below) |
| `PATCH /v1/views/{id}` | only what is sent changes, never the `subject`; `view.updated` |
| `DELETE /v1/views/{id}` | 204; `view.deleted` |

Every response says `mine` (you own it) and `editable` (you may change it).

## What a view holds

- **`query`**: the list route's own parameters, as strings: flat filters
  (`status`, `title.contains`, `custom.region.in`), `filter` (the JSON tree
  as a string), `sort`, `q`. Never paging (`limit`, `cursor`, `page`,
  `count`), `fields`, `deleted` or `lang`: each is a 400 naming
  `query.<parameter>`.
- **`columns`**: item fields to show, in order, each one of the list's
  `select`. `null`: the list's own.
- **`visibility`**: `private` (default), `team` (with `teamId`) or `tenant`.

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
- **Team**: a member of the team (`user_teams`, the team itself, not those
  below it), or a holder of `Access.manageViews`. Seen by the team's members.
  Deleting the team deletes its views.
- **Tenant**: `Access.manageViews` only (users only, never while
  impersonating, like every Access action); seen by everyone who may read the
  list. Names are unique per list within the team or tenant.
- **Changing or deleting**: the owner; a shared view also a holder of
  `Access.manageViews`, who may not make another's view private (it would
  vanish for everyone else) and never sees a private view or a team's they are
  not in. Everyone else gets a 403 on a view they see.

## Account and data

Views are a `PersonalDataSource`: the owner's views are in their data export.
On **account deletion** their private views are deleted and their shared ones
stay, ownerless (`owner: "anonymous"`), changeable by view managers only. A
membership ended (a user deprovisioned from a tenant) leaves their shared
views in place; their private ones become unreachable with the account's
access to that tenant and go when the tenant or the account does.

The table `saved_views` is a tenant table behind row-level security
([tenancy.md](tenancy.md)); its `team_id` is a composite key to `teams`
(cascade). Audited like any record (`view.created`, `view.updated` with
what changed, `view.deleted`).

Not in this first version: views in the exports and scheduled reports
(`filters` of a report are the list's `query`, so a view's `query` can be
sent as an export's `filters`), a default view per user, ordering views.

Tests: `apps/api/test/views.e2e-spec.ts`.
