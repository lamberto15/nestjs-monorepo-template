---
'@nestjs-monorepo-template/api-client': minor
---

`POST /v1/auth/email/verification/resend { email }`: send the verification link again without a session (a sign-up whose address is not proved yet). Always 202 `{ accepted: true }`; bot check action `resend-verification`. Additive: nothing existing changes.
