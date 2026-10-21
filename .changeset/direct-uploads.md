---
'@nestjs-monorepo-template/api-client': minor
---

Uploads straight to the object store with `STORAGE_DRIVER=s3`: `POST /v1/<records>/{id}/attachments/presign` (name, size and type in; a signed `PUT` URL, its headers and an `uploadId` out) and `POST …/attachments/complete` (`uploadId` in; the attachment out, after the server checked the object's size, type and first bytes). `GET /v1/features` has a new `presignedUploads` flag; with another driver the routes answer 503 `presigned_uploads_unavailable`.
