---
'@nestjs-monorepo-template/api-client': minor
---

Push and SMS: `PUT/GET /v1/devices` and `DELETE /v1/devices/{id}` (push devices), `GET/PUT/DELETE /v1/messaging/phone` and `POST /v1/messaging/phone/verify` (the SMS number, masked, confirmed by a texted code), and `POST /v1/webhooks/sms/{provider}` (the provider's signed STOP/START). Notification preferences take `sms` and `push` (booleans per type) when the providers are configured.
