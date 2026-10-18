---
'@nestjs-monorepo-template/api-client': minor
---

Comments (`GET`, `POST` and `PATCH` on `/v1/{feature}/{id}/comments`) carry `mentionNames`, the name of each key in `mentions` (`{ "user:<id>": "Maya Patel" }`), as every member sees it: a person who left the tenant keeps their name, as `authorName` does; null for anyone the tenant never had. `?fields=mentionNames` picks it.
