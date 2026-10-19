---
'@nestjs-monorepo-template/api-client': minor
---

Custom fields administration: `GET /v1/custom-fields/subjects` lists the subjects that take custom fields, each with its `label` (`singular`, `plural`) in the request's language and only those whose fields you may read; `GET /v1/custom-fields?include=counts` (managers only) adds `valueCount` and `deletedValueCount` to each field: how many records of your tenant hold a value of it, and how many of those are in the recycle bin. A definition's 400 `validation_failed` names `options.<i>.value` for each repeated or comma-bearing option value (it named `options`).
