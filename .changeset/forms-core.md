---
'@nestjs-monorepo-template/api-client': minor
---

Forms (opt-in, `forms.enabled`): `/v1/forms` (create, draft under its revision, publish immutable versions, archive) and `/v1/forms/{id}/submissions` (answers checked against the published version, Idempotency-Key required).
