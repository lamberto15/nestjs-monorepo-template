---
'@nestjs-monorepo-template/api-client': minor
---

Approvals: `outcomeAppliedAt` (ISO datetime, or null) on every approval (`GET /v1/approvals`, `GET /v1/approvals/{id}`, the decision routes): null while an approved request's outcome hasn't been applied yet (and again after a resubmission), so a record banner can show "approved, applying". The realtime event `approval.applied { id, subject, recordId, outcomeAppliedAt }` reaches the requester and the round's approvers once it is applied.
