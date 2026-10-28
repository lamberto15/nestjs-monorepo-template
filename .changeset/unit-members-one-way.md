---
'@nestjs-monorepo-template/api-client': minor
---

`GET /v1/access/organizational-units/{id}/members` returns each member's `name` and `email` beside `userId`. `PATCH /v1/access/users/{id}` no longer accepts `unitIds` (400): change a membership with the unit's members routes (`POST`, `PATCH`, `DELETE`); `unitIds` stays on user creation and invitations.
