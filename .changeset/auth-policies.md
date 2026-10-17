---
"@nestjs-monorepo-template/api-client": minor
---

`GET /v1/auth/me` has `mfaEnrollmentRequired`: the tenant (or one of the
user's teams) requires two-factor (`auth.requireMfa`) and the user has
none, so other routes answer 403 `mfa_enrollment_required` until they set
it up (`POST /v1/auth/mfa/enroll`, then `/confirm`).
