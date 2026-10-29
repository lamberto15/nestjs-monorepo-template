---
'@nestjs-monorepo-template/api-client': minor
---

Native apps: `POST /v1/auth/token/refresh` takes `tenantId` (the new pair acts in that tenant); `POST /v1/auth/token/exchange` turns a handoff code (a provider or SSO login started with `redirectUri` and `codeChallenge`, or `POST /v1/auth/magic-link/handoff`) into tokens; `POST /v1/auth/app-attestation/challenge` and `/keys`, and the `X-App-Attestation` header in place of `X-Captcha-Token`.
