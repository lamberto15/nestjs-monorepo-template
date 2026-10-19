---
'@nestjs-monorepo-template/api-client': minor
---

`GET /v1/people?key=user:<id>,client:<id>` names up to 20 principal keys for any member (a member or former member of the tenant, an API client of it; any other key is left out), for the names behind a list's `ref: principal` values. `GET /v1/teams` is a teams lookup any member may read (`id`, `name`, `parentId`, `depth`; `q`, `id=`, cursor pages), for a list's `ref: team` fields. The list metadata's `ref` description points at both.
