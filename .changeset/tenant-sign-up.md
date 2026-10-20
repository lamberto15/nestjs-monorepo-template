---
'@nestjs-monorepo-template/api-client': minor
---

`POST /v1/auth/sign-up` takes an optional `tenantName`, and `GET /v1/auth/methods` says `tenantSignUp` (optional in the type, always sent): with `TENANT_SIGN_UP=on` a sign-up makes its own tenant, the new account its administrator. Additive: nothing existing changes.
