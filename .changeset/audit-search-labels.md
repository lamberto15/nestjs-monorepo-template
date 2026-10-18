---
'@nestjs-monorepo-template/api-client': minor
---

Audit log: `actorLabel` filters on `GET /v1/access/audit` (`actorLabel`, `actorLabel.contains`, `actorLabel.startsWith`: who acted, by a member's name or address or an API client's name) and `GET /v1/lists/Audit`. Search: each hit of `GET /v1/search` carries `subjectLabel` (`{ singular, plural }`, in the response's language).
