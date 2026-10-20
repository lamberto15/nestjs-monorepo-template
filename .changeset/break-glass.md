---
'@nestjs-monorepo-template/api-client': minor
---

Break-glass for operators: `POST /v1/tenants/{id}/break-glass { reason, minutes? }` opens a tenant read only for an hour at most (send the grant's id as the `Break-Glass` header of GET requests), `GET /v1/tenants/{id}/break-glass` lists your grants, `DELETE /v1/tenants/{id}/break-glass/{grantId}` ends one. New permission `Platform.breakGlass`, notification `security.breakGlassStarted`, tenant setting `auth.allowBreakGlass`.
