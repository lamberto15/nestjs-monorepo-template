---
'@nestjs-monorepo-template/api-client': minor
---

`GET /v1/auth/tenants` items have `operator` (an operator tenant: the only one whose session can turn `platform.mode` off). `GET /v1/auth/tenants` and `POST /v1/auth/tenant` also answer while the deployment is in maintenance mode, so an operator who is in another tenant can switch back and end it.
