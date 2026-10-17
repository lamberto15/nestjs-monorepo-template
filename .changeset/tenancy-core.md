---
"@nestjs-monorepo-template/api-client": minor
---

Tenancy (roadmap 1a), breaking: users carry the `tenantId` they act in, and
`GET /auth/me` the `tenant`; new routes `GET /auth/tenants`,
`POST /auth/tenant` (switch: the session is re-issued), `GET /tenants` and
`POST /tenants` (operators); `POST /auth/token` takes an optional `tenantId`.
The settings scope `global` is now `tenant`. Every other route answers within
the caller's tenant.
Invitations replace administrator-made accounts: `POST /access/users` answers
202 with the invitation, `POST /auth/invitations/accept` takes its token.
Sign-up makes no session; `POST /auth/email/verify` takes the sign-up's
`password`.
