---
"@nestjs-monorepo-template/api-client": minor
---

New route `POST /v1/account/deletion/cancel { token }`: cancels a pending
account deletion with the token of the deletion mail's link, without a
sign-in. `GET /v1/auth/oidc/{provider}/login` takes `reauthenticate=true`
(a step-up through the provider, with a fresh login there), and
`POST /v1/auth/mfa/verify` documents the bot-protection header
`X-Captcha-Token` (a wrong code counts as a failed sign-in).
