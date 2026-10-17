---
"@nestjs-monorepo-template/api-client": minor
---

Passkeys (WebAuthn, roadmap 3): `GET /auth/passkeys`,
`POST /auth/passkeys/registration/options` and `POST /auth/passkeys`
(register), `PATCH` and `DELETE /auth/passkeys/{id}`; signing in with
`POST /auth/passkeys/sign-in/options`, then `POST /auth/passkeys/sign-in`
(browser) or `POST /auth/passkeys/token` (app, with an optional `tenantId`);
`POST /auth/passkeys/reauthentication/options`, and `POST /auth/reauthenticate`
takes `passkey`. `GET /auth/methods` has `passkeys`.
