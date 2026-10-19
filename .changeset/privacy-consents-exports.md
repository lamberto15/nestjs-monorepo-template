---
'@nestjs-monorepo-template/api-client': minor
---

Consents can be withdrawn and their kinds are declared: `DELETE /v1/account/consents/{kind}` withdraws one (200 with its state; 409 `consent_required` for a required kind, 404 when none is in force), each consent has `withdrawnAt` (null: in force), and `GET /v1/account/consent-kinds` (public) lists the kinds asked for (`kind`, current `version`, `required`, `label`, `description`). `POST /v1/account/consents` now accepts only those kinds at their current version (400 `validation_failed` otherwise). `POST /v1/account/export` declares its 202 body (`{ id, status }`), and `GET /v1/account/exports` lists your account exports, newest first, by cursor. Every transfer status (`GET /v1/data/transfers`, `/{id}`) gains `createdAt`, `finishedAt` and `expiresAt`. `GET /v1/auth/me` gains `hasPassword`: whether asking for the account's deletion wants the password.
