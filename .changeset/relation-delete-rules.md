---
'@nestjs-monorepo-template/api-client': minor
---

Record relationships: `related` of `GET /v1/lists/{subject}` says each relation's `onDelete` (`restrict` or `keep`). `restrict` is the default for every reference, optional ones included: deleting a record live ones refer to is a 409 `record_referenced` (before, an optional reference let it go to the recycle bin). Restoring a record whose `restrict` reference points at one in the recycle bin is a 409 `reference_deleted`.
