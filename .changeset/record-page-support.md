---
'@nestjs-monorepo-template/api-client': minor
---

Record pages: `GET /v1/notes/{id}` and `GET /v1/notes` take `?include=can`,
which adds `can: { update, delete, restore }` to each note (what its routes
would allow you now; not part of the ETag). `POST /v1/notes` and
`POST /v1/notes/{id}/restore` answer with the strong ETag `GET` sends, good
as `If-Match` at once. Notes no longer carry `tenantId` (it was never in the
schema). CORS exposes `ETag`, `Location` and `Idempotent-Replayed` to
browser apps on `CORS_ORIGINS`.
