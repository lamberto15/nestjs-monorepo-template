---
'@nestjs-monorepo-template/api-client': minor
---

Image attachments (JPEG, PNG, WebP, GIF) carry `renditionStatus` (`pending` | `ready` | `failed`, null for anything else) and `renditions` (`thumb` and `preview`: width, height, size, contentType), and `GET /v1/attachments/{id}/download?rendition=thumb|preview` links to them (404 `attachment_rendition_not_found` when there is none). `record.attachments.changed` has a new action, `processed`.
