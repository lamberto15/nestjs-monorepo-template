---
'@nestjs-monorepo-template/api-client': minor
---

`createApiClient` looks up `globalThis.fetch` on every request instead of keeping the one it saw at creation, so a fetch replaced later (msw, instrumentation) is used; a `fetch` option still wins. `unwrap()` returns `undefined` for a 2xx without a body (204: sign-out, deletes, `POST /v1/auth/tenant`) instead of throwing `empty_response`, and is typed `undefined` for those operations; a 304 still throws `not_modified`. Each item of `GET /v1/auth/sessions` has a readable `device` ("Chrome on macOS", null when no user agent was recorded).
