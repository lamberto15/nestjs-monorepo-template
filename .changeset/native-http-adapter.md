---
'@nestjs-monorepo-template/api-client': patch
---

The API runs on Nest's native `node:http` adapter instead of Express. On the wire: paths are case-sensitive (`/V1/notes` is a 404), a path parameter over 2048 characters is a 414, and JSON responses of routes without an `ETag` of their own no longer carry Express's weak one (routes marked with one still answer 304 and 412).
