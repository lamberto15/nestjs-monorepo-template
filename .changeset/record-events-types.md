---
'@nestjs-monorepo-template/api-client': patch
---

`RealtimeEvents` types the record events: `record.commented`
(`{ subject, recordId, commentId, action }`) and
`record.attachments.changed` (`{ subject, recordId, attachmentId, action }`),
so `realtime.on('record.commented', …)` is typed.
