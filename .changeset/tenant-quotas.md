---
'@nestjs-monorepo-template/api-client': minor
---

Tenant quotas: `PUT /v1/tenants/{id}/quotas` (operators) sets a tenant's `maxMembers`, `maxApiClients`, `maxStorageBytes` and `maxRecords` per feature; `GET /v1/tenants/{id}/usage` (operators) and `GET /v1/tenant/usage` (administrators) show use against the limits. Creating past a limit answers 422 `quota_exceeded` with `quota: { resource, limit, used }`. Defaults are the `quotas.*` platform settings.
