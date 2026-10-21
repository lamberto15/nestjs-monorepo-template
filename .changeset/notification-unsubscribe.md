---
'@nestjs-monorepo-template/api-client': minor
---

New public endpoint `POST /v1/notifications/unsubscribe/{token}`: the one-click unsubscribe (RFC 8058) behind the `List-Unsubscribe` header of notification and digest mail. It takes the form `List-Unsubscribe=One-Click` (JSON with the same field works too), answers 204 and switches that notification type (or a digest's types) off in the mail preferences, and answers 400 for any invalid, expired or foreign link.
