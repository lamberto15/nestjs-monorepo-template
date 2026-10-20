---
'@nestjs-monorepo-template/api-client': minor
---

A tenant registers its own senders of incoming webhooks: `GET/POST /v1/webhook-senders`, `GET/PATCH/DELETE /v1/webhook-senders/{id}` and `POST /v1/webhook-senders/{id}/rotate-secret` (the secret is in the create and rotate answers only), and the senders POST signed events to `POST /v1/webhooks/tenants/{tenantId}/senders/{name}`. Additive: nothing existing changes.
