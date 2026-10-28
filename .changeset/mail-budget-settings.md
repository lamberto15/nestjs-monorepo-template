---
'@nestjs-monorepo-template/api-client': minor
---

Daily mail budgets: the tenant quota `maxMailsPerDay` on `PUT /v1/tenants/{id}/quotas` (default: the `quotas.maxMailsPerDay` setting), and `mailsPerDay: { used, limit }` in `GET /v1/tenants/{id}/usage` and `GET /v1/tenant/usage`. The deployment's budget is the `mail.dailyLimit` setting, with `mail.essentialOnlyPercent` (past it, only essential mail goes).
