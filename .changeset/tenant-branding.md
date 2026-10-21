---
'@nestjs-monorepo-template/api-client': minor
---

Tenant branding: `GET /v1/branding` (colour, mail sender name, logo path, `locked`, `canEdit`), `PUT /v1/branding` (`primaryColor` as `#rrggbb`, `mailFromName`; `null` removes), `POST /v1/branding/logo` (multipart `file`, PNG/JPEG/WebP up to 512 KB), `DELETE /v1/branding/logo`, and the public `GET /v1/branding/{tenantId}/logo` (302 to the image). Settings `branding.primaryColor`, `branding.mailFromName` and the operators' `branding.locked` (409 `branding_locked` while on).
