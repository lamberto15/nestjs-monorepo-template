---
'@nestjs-monorepo-template/api-client': minor
---

`?include=watching` (beside `include=can`) on the detail and list routes of every record with the `watch` capability adds `watching: boolean` to each record: whether the caller watches it, answered from one query per page. A record page needs no extra `GET /v1/subscriptions` request, and a list can show a watching marker. Left out by default; not part of the ETag; a 400 on a record that cannot be watched.
