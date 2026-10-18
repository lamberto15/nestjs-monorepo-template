---
'@nestjs-monorepo-template/api-client': minor
---

`GET /v1/data` has a response schema: `exports` (`name`, `columns`, `formats`) and `imports` (`name`, `formats`, `columns` with `type`, `required`, `min`, `max`, `options`, `example`…, `template`), so the client types it instead of `unknown`. New lists of your own background work in the current tenant, newest first, by cursor (`{ items, nextCursor }`): `GET /v1/data/transfers` (`?kind=export|import`; each item as `GET /v1/data/transfers/{id}` answers it) and `GET /v1/bulk` (each run as `GET /v1/bulk/{id}` answers it, with the result's counts but not the result per item).
