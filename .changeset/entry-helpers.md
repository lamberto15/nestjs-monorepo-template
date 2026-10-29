---
'@nestjs-monorepo-template/api-client': minor
---

Record templates: `GET /v1/templates/subjects`, `GET/POST /v1/templates`, `GET/PATCH/DELETE /v1/templates/{id}` and `GET /v1/templates/{id}/preview` (values to prefill a create, checked again against the create schema and the caller's permissions). New permission `Access.manageTemplates`. Dependent choices: `GET /v1/choices`, `GET /v1/choices/{set}`, `GET /v1/choices/{set}/{field}/options` and `POST /v1/choices/{set}/validate`.
