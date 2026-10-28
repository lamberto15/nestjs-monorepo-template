---
'@nestjs-monorepo-template/api-client': minor
---

Access administration: `GET /v1/access/users/{id}`, `GET /v1/access/roles/{id}` and `GET /v1/access/clients/{id}`; `?unitId=` (and `unitId.in`) on `GET /v1/access/users`; `POST /v1/access/invitations/{id}/resend` and `roleExpiresAt` on the pending invitations; `dailyQuota` on `POST /v1/access/clients`; `DELETE /v1/access/clients/{id}`; `GET /v1/lists/User`. The catalog's labels follow the request's language.
