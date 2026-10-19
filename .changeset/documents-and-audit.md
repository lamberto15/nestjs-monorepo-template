---
'@nestjs-monorepo-template/api-client': minor
---

Documents: `GET /v1/notes/{id}/documents` (and `/{id}/documents` on every record with PDFs) lists a record's documents, in progress ones too (`RecordDocumentPage`: `template`, `language`, `issuedBy { key, name }`, `finishedAt`, `attachmentId`); `GET /v1/lists/{subject}` has `documentTemplates: [{ id, language }]`; `POST …/{id}/pdf` declares `?lang=` (an enum of the shipped languages); a record's `can` (`?include=can`) has `issue` where it takes PDFs. `GET /v1/attachments/{id}/download?inline=true` shows a PDF in the browser. The audit log is typed as `AuditPage` of `AuditEntry`, whose entries gain `actorName`; `GET /v1/teams` documents its `limit` (50 by default, 100 at most).
