---
'@nestjs-monorepo-template/api-client': minor
---

New public, read-only endpoint `GET /v1/notifications/unsubscribe/{token}`: says what a mail's unsubscribe link would stop, without changing anything. It answers `{ kind: 'type', label }` (the notification type's label in the request's language, or `null` when the link would change nothing) or `{ kind: 'digest', modes }`, and the same 400 as the `POST` for an invalid, expired or foreign link. Additive: nothing existing changes.
