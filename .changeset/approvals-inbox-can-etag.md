---
'@nestjs-monorepo-template/api-client': minor
---

`GET /v1/approvals`: each item has the `can` (`decide`, `cancel`, `resubmit`) and the `etag` its `GET /v1/approvals/{id}` would give you, so an inbox row can decide with `If-Match` without reading the request first (`?fields=` keeps both). A `decidedByMe` filter (`?decidedByMe=true`, or in `filter=`) lists what you decided, yourself or standing in for someone: the inbox's history.
