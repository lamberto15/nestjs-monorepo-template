---
'@nestjs-monorepo-template/api-client': minor
---

Bulk runs carry their times: `createdAt`, `startedAt` and `finishedAt` (ISO datetimes; the last two null until a worker takes the run up and until it ends) on every item of `GET /v1/bulk` and on `GET /v1/bulk/{id}`. `GET /v1/bulk` takes `?status=queued|running|completed|failed` and `?kind=delete|restore|update` (the action; 400 for any other word), and `GET /v1/data/transfers` takes `?status=` too; a filtered page may hold fewer than `limit` items while `nextCursor` is set, so follow it until it is null. A comment's `mentionNames` also names a mention written as an address (`@maya@example.com`) under that address, lower-cased, besides its `user:<id>` key; an address that mentioned nobody gets no entry.
