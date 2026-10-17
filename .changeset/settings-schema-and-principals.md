---
'@nestjs-monorepo-template/api-client': minor
---

Settings describe their values and who may set them; the access API's read routes are typed (#111).

- `GET /v1/settings` and `/v1/settings/{key}`: each setting adds `type` (`boolean | number | string | enum | json`), `options` (enums), `min`/`max`/`integer` (numbers), `maxLength` (strings) and `schema` (its JSON Schema), generated from the declaration's Zod schema; `canEdit` (you may set its value for the tenant, a team or a principal) and `canSetMine` (you may set your own).
- New `GET /v1/access/principals?q=&kind=user|client`: the tenant's users and API clients searched by name or address, as principal keys (`user:<id>`, `client:<id>`), cursor-paged; for those who may list users and clients.
- `GET /v1/access/users`, `/v1/access/roles` (and `POST`), `/v1/access/catalog` and `/v1/access/audit` declare their responses: no longer `never`. The users list no longer carries `tenantId` (always null).
- `DELETE /v1/settings/{key}` was already a typed 204 (`unwrap()` returns `undefined`); a test now holds it.
