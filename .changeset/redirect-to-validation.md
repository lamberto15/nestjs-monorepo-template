---
'@nestjs-monorepo-template/api-client': patch
---

`redirectTo` (`POST /v1/auth/magic-link`, `GET /v1/auth/oidc/{provider}/login`): a path of the web app only (one leading `/`, printable ASCII, no `\`, at most 2,048 characters), with the pattern in the schema; anything else is a 400 on the magic link and ignored by the OIDC login.
