---
'@nestjs-monorepo-template/api-client': minor
---

Tenants for operators: `GET /v1/auth/me`'s `tenant` gains `operator` (true in the operator tenant, where the operators' routes answer). `GET /v1/tenants` is a page (`nextCursor`, and `page`, `total` on request) with `listQuery()` filters (`name`, `slug`, `active`, `operator`, `createdAt`, `updatedAt`), `sort` and `fields`, newest first (it was every tenant, oldest first), described at `GET /v1/lists/Tenant`. New `GET /v1/tenants/{id}` (with an ETag) and `PATCH /v1/tenants/{id} { name?, slug?, active? }` (If-Match; 409 `operator_tenant` when deactivating the operator tenant). 409 `tenant_slug_taken` carries `errors: [{ path: 'slug' }]`. `POST /v1/tenants` answers the tenant with `administrator: { email, status: 'invited', expiresAt }`.
