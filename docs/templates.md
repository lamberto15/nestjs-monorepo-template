# Record templates

Values to prefill a new record, kept under a name: "Weekly status", "New
hire checklist". Private to their owner, shared with an organizational
unit, or tenant-wide. `apps/api/src/platform/templates/`. Every record
`pnpm feature:add` generates takes them (`recordParts()` registers its create
schema), so a feature does nothing to get them.

**A template creates nothing and bypasses nothing.** It is only a body to
prefill a form with. The client previews it, lets the user edit it, and creates
the record through the subject's own route (`POST /v1/test-items`…), which
validates and authorizes it as every create does: its schema, the caller's
`create` permission and field permissions, custom fields, numbering,
idempotency, audit.

```http
POST /v1/templates
{ "subject": "Note", "name": "Weekly status", "visibility": "private",
  "values": { "title": "Weekly status", "body": "Done:\nNext:" } }

GET /v1/templates/{id}/preview
→ { "template": {…}, "values": { "title": "Weekly status", "body": "Done:\nNext:" }, "dropped": [] }

POST /v1/notes     # the preview's `values`, plus what the user adds
```

| Route                            | Does                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/templates/subjects`     | the records you may create, with the create fields you may set in a template                                                                                                                 |
| `GET /v1/templates`              | the templates you see: yours, those of your units, the tenant's, of records you may create; `?subject=`, `?visibility=`, `?unitId=`, `?name=`, `?name.contains=`, `?sort=name`; cursor pages |
| `POST /v1/templates`             | save one (201, audited `recordTemplate.created`)                                                                                                                                             |
| `GET /v1/templates/{id}`         | one you see (another's private template, a unit's you are not in, one of records you may not create: 404)                                                                                    |
| `GET /v1/templates/{id}/preview` | the template checked again, as a create body (below)                                                                                                                                         |
| `PATCH /v1/templates/{id}`       | only what is sent changes, never the `subject`; `values` replaces all values; `recordTemplate.updated` with what changed                                                                     |
| `DELETE /v1/templates/{id}`      | 204; `recordTemplate.deleted`                                                                                                                                                                |

Every response says `mine` (you own it) and `editable` (you may change it).

## What a template holds

`values`: fields of the subject's **create body**, as that route takes them
(`title`, `body`, `custom: { region: "eu" }`). It is checked against that body
when saved, a value at a time, since required fields may be left out:

- A key that is not a create field is a 400 `values.<field>`: ids, numbers,
  owners, units, dates and every other value the system sets are not fields of
  the create body, and `namingSeriesId` (the number's series, chosen at
  create) is refused too. Secrets (encrypted columns, tokens, keys) are not
  record fields, so a template cannot hold them.
- A value the schema refuses, or a custom value its field does not take, is a
  400 naming it (`values.title`, `values.custom.region`).
- A field the **saver** may not set (field-level permissions) is a 403
  `field_forbidden` naming it; so is a subject they may not create.

## Preview: checked again, for whoever uses it

`GET /v1/templates/{id}/preview` validates every value again against the
create schema **as it is now**, the tenant's active custom fields as they are
now, and **the caller's** field permissions (not the saver's). It answers
`values`, what still holds, and `dropped`, what no longer does, each with a
`reason`:

| `reason`    | Because                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `unknown`   | no longer a create field (a field removed, renamed or made system-set)                       |
| `invalid`   | the schema refuses it now (a type, a length, a custom choice removed or a field deactivated) |
| `forbidden` | the caller may not set that field                                                            |

A stale template is therefore not an error: the form is prefilled with what
holds and says what was left out; change the template to fix it. A caller who
may not create the subject gets a 403.

## Who may do what

Exactly as saved views ([saved-views](saved-views.md), "Who may do what"):

- **Private**: anyone signed in, users and API clients. Names are unique per
  subject and owner, whatever the case (409 `conflict`). At most 100 per owner.
- **Unit**: a current member of the unit, or a holder of
  `Access.manageTemplates`.
- **Tenant**: `Access.manageTemplates` only (users, never while impersonating).
- **Changing or deleting**: the owner; a shared template also a holder of
  `Access.manageTemplates`, who never sees a private one.

Shared-template changes are audited like any record (`recordTemplate.created`,
`updated` with what changed, `deleted`). Templates are a `PersonalDataSource`:
the owner's are in their data export; on account deletion their private ones
are deleted and shared ones stay, ownerless. The table `record_templates` is a
tenant table behind row-level security ([tenancy](tenancy.md)); a unit with
templates shared with it cannot be deleted (409 `unit_not_empty`).

Not in this first version: the web app's "New from template" menu, and
templates for API-created records with attachments or tags (those are not
create-body fields).

Tests: `apps/api/test/templates.e2e-spec.ts`.
