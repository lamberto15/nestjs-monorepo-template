---
'@nestjs-monorepo-template/api-client': minor
---

The operations routes are typed: `GET /v1/ops/outbox` (`stats`, `deadLetters`, `notifications`, `canManage`), `GET /v1/ops/queues`, the `retried`, `requeued` and `purged` counts of `POST /v1/ops/queues/{name}/retry-failed`, `POST /v1/ops/dead-letters/requeue` and `…/purge`, and the `data` of `GET /v1/ops/events` as a union by `source` (workflow, webhooks, outbox, idempotency, locks, mail, resilience), then by `type`. Error messages, payloads and headers are masked as in the logs and cut before they reach the browser, and a stack trace never does: an event's `error` is `{ name?, message }`. A resilience event's own `source` is now `origin` (it used to overwrite the stream's `source` tag).
