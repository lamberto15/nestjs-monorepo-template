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
(`PUT /v1/settings/forms.enabled/platform`), every `/v1/forms` route answers
404. It is public, so the web app can hide forms.

## Permissions

The subject `Form` has four rights, none implying another
([permissions](permissions.md)):

| Action | Allows |
| --- | --- |
| `read` | the published forms and their versions |
| `submit` | filling in a published form, and reading one's own submissions |
| `edit` | creating forms, editing drafts, publishing, archiving |
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

- **The definition** (format 1) is `sections[]` of `{ key, title?, description?, fields[] }`;
  a field is `{ key, type, label, help?, placeholder?, required?, default?, options?, validation?, translations? }`.
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
  *n + 1*; editing the draft never changes a published version. Once
  published, a key keeps its type forever (the form's `keyTypes`): a draft
  that retypes it is refused, so old answers stay readable. A new meaning
  takes a new key.
- **Slugs** are unique per tenant (409 `form_slug_taken`). Archiving hides a
  form from submitters and refuses new answers; its versions and
  submissions stay.

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

## Not yet

The web renderer and builder (#545, #546), conditional rules (#547), pages
and repeatable groups (#548) and choice sources (#549) build on this.
Public, anonymous forms are #583.
