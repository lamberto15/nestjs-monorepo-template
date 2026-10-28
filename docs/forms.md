# Forms

Administrators build forms at runtime (an intake, a questionnaire, a
checklist) and people fill them in, without a migration or a deploy. A form
is data, never code: sections of typed fields, validated on the server when
it is saved, published and answered. It is opt-in per tenant and separate
from [custom fields](custom-fields.md), which extend existing records. The
code is in `apps/api/src/platform/forms/`; the epic is #542.

## Turning it on

The setting `forms.enabled` (default off, [settings](settings.md)): until a
tenant's administrator turns it on, or the operators do for every tenant
(`PUT /v1/settings/forms.enabled/platform`), every `/v1/forms` route answers 404. It is public, so the web app can hide forms.

## Permissions

The subject `Form` has four rights, none implying another
([permissions](permissions.md)):

| Action          | Allows                                                               |
| --------------- | -------------------------------------------------------------------- |
| `read`          | the published forms and their versions                               |
| `submit`        | filling in a published form, and reading one's own submissions       |
| `edit`          | creating forms, editing drafts, publishing, archiving                |
| `readResponses` | everyone's submissions and their answers (never through break-glass) |

`edit` is not `manage`: CASL reads `manage` as every action, answers
included.

## Definitions and versions

```text
POST   /v1/forms                          { slug, name, description?, definition? }
PATCH  /v1/forms/{id}                     slug, name, description
GET    /v1/forms/{id}/draft               the draft and the form's revision
PUT    /v1/forms/{id}/draft               { revision, definition }
POST   /v1/forms/{id}/publish             { revision }: the draft as the next version
POST   /v1/forms/{id}/archive | unarchive
GET    /v1/forms/{id}/published           what a renderer shows and submits
GET    /v1/forms/{id}/versions[/{version}]
DELETE /v1/forms/{id}                     only a form never published
```

- **The definition** is `{ format, sections[] }`, a section
  `{ key, title?, description?, visibleWhen?, fields[] }`, a field
  `{ key, type, label, help?, placeholder?, required?, default?, options?, validation?, visibleWhen?, requiredWhen?, translations? }`.
  **Formats**: 1 is fields and sections; 2 adds conditions
  ([Conditions](#conditions)). A definition sent without `format` takes the
  latest; a stored format-1 version keeps meaning what it meant, and a
  condition in a format-1 definition is refused.
  Types: `text`, `textarea`, `email`, `url`, `integer`, `decimal`, `date`,
  `checkbox`, `select`, `multiSelect`, `radio`. Texts are plain (no HTML);
  patterns run on RE2. A key is a slug (`^[a-z][a-z0-9_]{0,49}$`), unique in
  the form.
- **Limits**, whatever an administrator asks: 50 sections, 200 fields,
  200 options a field, 10 translations, 64 KiB as JSON. A refused definition
  answers 400 with each problem at its path (`definition.sections.0.fields.2.options`).
- **Concurrency**: every draft save and publish sends the `revision` it
  edited; a stale one is 409 `form_conflict`, never an overwrite.
- **Versions are immutable.** Publishing snapshots the draft as version
  _n + 1_; editing the draft never changes a published version. Once
  published, a key keeps its type forever (the form's `keyTypes`): a draft
  that retypes it is refused, so old answers stay readable. A new meaning
  takes a new key.
- **Slugs** are unique per tenant (409 `form_slug_taken`). Archiving hides a
  form from submitters and refuses new answers; its versions and
  submissions stay.

## Conditions

A section or a field can show only when a condition holds (`visibleWhen`),
and a field can be required only when one holds (`requiredWhen`, beside
`required`, which is "always"). A condition is data, checked when the draft
is saved and when it is published, never code: no expression language, no
eval, no pattern from an administrator. The code is
`apps/api/src/platform/forms/form-rules.ts`.

```json
{ "field": "topic", "op": "eq", "value": "other" }
{ "all": [ { "field": "seats", "op": "gte", "value": 5 }, { "not": { "field": "email", "op": "isEmpty" } } ] }
```

- **A predicate** `{ field, op, value }` reads the answer of a field
  **before** it in the form (in an earlier section, or earlier in its own):
  a field after it, itself, or an unknown key is refused at its path
  (`definition.sections.0.fields.3.visibleWhen.field`). So no cycle can
  form, and one pass in form order decides everything.
- **Operators by type**: text and email `eq`, `ne`, `in`, `isEmpty`;
  textarea and url `isEmpty`; integer `eq`, `ne`, `gt`, `gte`, `lt`,
  `lte`, `in`, `isEmpty`; decimal and date the comparisons and `isEmpty`
  (dates compare as `YYYY-MM-DD`); checkbox `eq`, `ne` (`true` or
  `false`); select and radio `eq`, `ne`, `in` (option values the field
  has), `isEmpty`; multiSelect `contains` (one of its options), `isEmpty`.
  A value of another type, or an option the field lacks, is refused.
- **Groups**: `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`, at most
  4 inside each other, 20 predicates and 50 values of an `in` in one
  condition. `required: true` takes no `requiredWhen`.
- **Empty**: a missing answer, a hidden field's included, is empty: every
  comparison with it is false, `ne` true, `isEmpty` true. Defaults count
  as answers. Values compare as the server normalizes them (`"3"` is 3).
- **Hidden answers are stripped**, deterministically: the answer to a field
  that its conditions (or its section's) hide is not checked, not stored and
  not filled with its default, whatever the client sent; a hidden field is
  never required. A client showing a stale form loses nothing it should keep
  and can't store an answer the form says doesn't apply.
- **The same in the browser**: `apps/web/src/features/forms/rules.ts`
  mirrors the evaluator, and its test (`rules.test.ts`) runs both on
  generated cases, so what the page shows and requires is what the server
  checks. The server stays the authority.

## Submissions

```text
POST /v1/forms/{id}/submissions        { versionId, answers }   Idempotency-Key required
GET  /v1/forms/{id}/submissions        paginated, newest first
GET  /v1/forms/{id}/submissions/{sid}
```

- Answers are checked on the server against **that version's**
  definition: unknown keys, wrong types, values out of range or not among
  the options, and missing required answers are refused at
  `answers.<key>` (`answers.<key>.<index>` in a list); defaults fill
  what is left out; values are normalized (`"3"` becomes `3`). At most
  64 KiB of answers.
- A submission keeps its `versionId` and `version`: read its definition at
  `GET /v1/forms/{id}/versions/{version}`. Answers to a version that is no
  longer the published one are 409 `form_version_outdated` (with the current
  `versionId`).
- A retry with the same `Idempotency-Key` returns the first submission,
  never a second one.
- **Who sees what**: `readResponses` lists every submission; `submit` alone
  lists one's own; anyone else gets 403. A submission of someone else is a
  404 to a submitter.
- **The audit** records `form.submitted` with the form, the version and the
  submitter, never the answers. Answers are not encrypted at rest: don't
  collect secrets or sensitive data in a form ([encryption](encryption.md)).

## Tenancy

`forms`, `form_versions` and `form_submissions` carry `tenant_id` under
row-level security, with keys within the tenant ([tenancy](tenancy.md)):
another tenant's form or submission is a 404, even by id.

## The web app

`apps/web/src/features/forms`, under **Workspace → Forms** (`Form.read`):

- **The list** (`/forms`): each form's status, published version and
  unpublished changes. `Form.edit` creates one (name, and a slug made from
  it) and opens its builder. A tenant with `forms.enabled` off sees that
  forms are off.
- **The builder** (`/forms/{id}`): sections and their fields (type, label,
  key, help, required, options as `value = Label` lines), fields reordered by
  drag and drop or the keyboard, and a live preview drawn by the same
  renderer people fill in. Each field has **Show only when** and
  **Required when**, each section **Show this section only when**: rows of
  field (only those before it), operator and value, joined by all or any
  of them; the preview follows them as the page will. A deeper condition
  (`not`, groups in groups) made through the API shows as such and can be
  removed, not edited. Saved drafts are format 2. **Save draft** sends the whole draft under the
  revision it was read at; a 409 says someone else saved meanwhile, and the
  server's problems are listed at their paths. **Publish** is offered once
  the changes are saved.
- **Filling in** (`/forms/{id}/fill`, `Form.submit`): the published
  version's fields that its conditions show, each of its type (radio buttons, checkboxes, a select,
  number, date, text). Required answers and numbers are checked in the
  browser first, then the server's errors show at their fields; a newer
  version published meanwhile (409 `form_version_outdated`) is loaded again.
- **Submissions** (`/forms/{id}/submissions`): everyone's with
  `Form.readResponses`, one's own otherwise, each with its version and
  answers.

## Not yet

Pages and repeatable groups (#548) and choice sources (#549) build on
this.
Public, anonymous forms are #583.
