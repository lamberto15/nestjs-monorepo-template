---
'@nestjs-monorepo-template/api-client': minor
---

Tenants (operators): `POST /v1/tenants/{id}/export { format? }` (202, a data transfer followed at `GET /v1/data/transfers/{id}`; `Idempotency-Key`, a recent sign-in); `POST /v1/tenants/{id}/deletion { slug }` (deactivates now, erased after `TENANT_DELETION_GRACE_DAYS`; a recent sign-in) and `DELETE /v1/tenants/{id}/deletion` (cancels until the erase starts). A tenant has `deletionRequestedAt`, `deletionScheduledFor` and `deletionStartedAt` (ISO datetimes, or null). `PATCH /v1/tenants/{id} { active: true }` answers 409 `tenant_deletion_pending` while a deletion is pending.
