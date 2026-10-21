---
'@nestjs-monorepo-template/api-client': minor
---

Session lifetime policy: tenant settings `auth.sessionIdleMinutes` and `auth.sessionMaxHours` (under the deployment's `SESSION_IDLE_MINUTES` and `SESSION_MAX_HOURS`) end browser sessions and token clients' refresh-token families sooner. `GET /v1/auth/me` has a new `session { idleMinutes, lastActiveAt, expiresAt }` for a browser session.
