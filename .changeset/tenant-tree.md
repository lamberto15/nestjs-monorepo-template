---
'@nestjs-monorepo-template/api-client': minor
---

Tenant tree (holding groups): a tenant's `parentId` on `GET/PATCH /v1/tenants/{id}`, `POST /v1/tenants` and the `GET /v1/tenants` list (filter `parentId`, `parentId.isNull`); `GET /v1/access/consolidated/tenants` (the subtree a consolidated read spans) and `GET /v1/access/consolidated/audit` (the audit log of your tenant and the tenants below it), with the `Access.readConsolidated` permission. New 409 codes: `tenant_tree_cycle`, `tenant_has_children`.
