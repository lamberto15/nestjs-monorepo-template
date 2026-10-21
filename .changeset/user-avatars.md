---
'@nestjs-monorepo-template/api-client': minor
---

User pictures. `PUT /v1/account/avatar` (multipart, field `file`: a PNG, JPEG, WebP or GIF, at most 2 MB; answers `{ avatarUrl }`) and `DELETE /v1/account/avatar` set and remove the signed-in user's picture. `avatarUrl` (a path for an `<img>`, or null) is now on `GET /v1/auth/me`'s `user`, on every person `GET /v1/people` returns and on the access user list; `GET /v1/people/{id}/avatar` redirects to the file for a member of the tenant.
