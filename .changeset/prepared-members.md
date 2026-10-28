---
'@nestjs-monorepo-template/api-client': major
---

Prepared members (#604): `POST /v1/access/users` takes `send` (`false` prepares the member without a link; `email` is optional then) and answers `status`; `PATCH /v1/access/invitations/{id}` changes a pending invitation; `POST /v1/access/invitations/{id}/send` replaces `…/resend`. Pending invitations carry `status` (`prepared`, `sent`, `expired`) and `sentAt` instead of `expired`; `email` and `expiresAt` may be null. Members carry `managedByScim`.
