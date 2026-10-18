---
'@nestjs-monorepo-template/api-client': minor
---

Record panels: `GET /v1/lists/{subject}` answers `capabilities` (tags,
comments, attachments, revisions, pdf, bulk, watch, search, transfer,
custom, events, numbered, approvals), so a client shows only the panels a
subject has, and `attachmentLimits: { maxBytes, maxMb, types }` (null
without attachments), the limits the upload enforces. New `GET /v1/people?q=` (key and
name of the tenant's active members, for any member: @mention
autocomplete). Comments carry `authorName`, revisions `changedByName`.
Realtime: `record.commented` and `record.attachments.changed` reach a
record's watchers who may read it.
