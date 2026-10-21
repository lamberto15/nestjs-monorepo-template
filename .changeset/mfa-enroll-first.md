---
'@nestjs-monorepo-template/api-client': patch
---

`PUT /v1/settings/{key}` and `PUT /v1/settings/{key}/platform` may answer 409 `mfa_enroll_first` (requiring two-factor of a caller who has no authenticator). `GET /v1/features` stays reachable while a user is enrolling.
