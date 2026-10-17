---
'@nestjs-monorepo-template/api-client': minor
---

The notification preferences are typed. `GET /v1/notifications/types` (`channels`), `GET` and `PUT /v1/notifications/preferences` describe each channel's setting instead of `{ [key: string]: unknown }`: `email?: 'immediate' | 'hourly' | 'daily' | false` (users) and `webhook?: boolean` (API clients); in-app and realtime are always on and not settings. New `POST /v1/notifications/test` (development and tests only, absent in production) sends the caller a `system.test` notification through every channel they have on and answers `{ id }`.
