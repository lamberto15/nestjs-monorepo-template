# Document acknowledgments

"Did these people read this version of this document?" A person with the
right to change a document's record asks selected people to acknowledge it;
each confirms. `apps/api/src/platform/acknowledgments/`; the document is an
[attachment](attachments.md), so every feature that takes attachments has
this, with nothing to add.

An acknowledgment records who confirmed, which **version** and when. It is
not a signature and implies no legal consent.

| Route | Does |
| --- | --- |
| `POST /v1/attachments/{id}/acknowledgment-requests { recipients, dueAt? }` | 201; asks the people (`user:<id>`, at most 100 at a time, 500 per version) about the document's current version; `dueAt` must be in the future. Whoever may change the record (403), else a 404 if it can't be read |
| `GET /v1/attachments/{id}/acknowledgments?version=` | the completion dashboard: `total`, `acknowledged`, `pending`, `overdue` and each person's state. Same people |
| `POST /v1/attachments/{id}/acknowledgments/remind { recipients? }` | reminds those still waiting (or the named ones), nobody twice within 24 hours (`skipped`) |
| `DELETE /v1/attachments/{id}/acknowledgments/{ackId}` | withdraws a request nobody answered (409 `acknowledgment_answered` otherwise) |
| `POST /v1/attachments/{id}/acknowledge` | the person asked acknowledges (200); again changes nothing. A 404 for anyone nobody asked |
| `GET /v1/acknowledgments?status=pending\|acknowledged` | the caller's own, newest first (at most 100), for records they may still read |

- **Recipients** must be active members of the tenant who may read the
  record (400 `acknowledgment_recipient_invalid`). Asking again adds only
  the new people (a new `dueAt` replaces the old for those who haven't
  answered); an answer is never reset.
- **Notifications**: `acknowledgment.requested` and `acknowledgment.reminder`
  (email at once by default). There is no automatic reminder job yet:
  reminding is the requester's call (the dashboard's `overdue` shows who).
- **Audit**: `acknowledgment.requested`, `-reminded`, `-withdrawn`,
  `-acknowledged`, with the attachment as target, the `version` and name in
  the details. Realtime and webhooks are not sent.
- **Versions**: attachments are not versioned yet, so every document is
  version 1 (`versionOf()` in `acknowledgments.service.ts`, the one place to
  change when versions exist). A request is for one version, and a new
  version starts with no requests: ask again; the earlier version's
  answers stay, and the dashboard shows them with `?version=`. An
  acknowledgment never carries to a newer version.
- **Deactivation**: a removed attachment takes its requests and answers with
  it (the audit log keeps who acknowledged what); a deleted record's
  attachments go the same way. An account's deletion removes the person's
  requests and answers; their export lists them (`acknowledgments`).
