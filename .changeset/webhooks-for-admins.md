---
'@nestjs-monorepo-template/api-client': minor
---

Webhooks for signed-in administrators, the event types catalog, a test event and a paged delivery log (#124).

- New `/v1/access/clients/{clientId}/webhook-endpoints…` and `…/webhook-deliveries…`: the same routes as an API client's own, for a user with `Access.manageClients` acting on a client of their tenant; creating an endpoint and rotating its secret want a recent sign-in.
- New `GET /v1/webhook-event-types`: the declared types, grouped by feature, with descriptions.
- New `POST /v1/webhook-endpoints/{id}/test` (and its delegated twin): sends `webhook.test` to one endpoint, 202 with the delivery.
- `GET /v1/webhook-deliveries` is cursor-paged (`limit`, `cursor`, `count`, `nextCursor`), with the list query's filters (`status`, `endpointId`, `type`, `attempts`, `createdAt`), `filter`, `sort` and `fields`.
- `GET /v1/webhook-deliveries/{id}` adds `durationMs` and `lastRequest` (the headers sent with the latest attempt).
- An endpoint's `description` may not be an empty string (400); `null` clears it on PATCH.
