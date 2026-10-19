---
'@nestjs-monorepo-template/api-client': minor
---

The record panels' shared shapes are named components in the document, so `components['schemas']` always has `Comment`, `CommentPage`, `Attachment`, `AttachmentPage`, `TagRef`, `TagRefList`, `Tag`, `TagPage`, `Revision`, `RevisionPage` and `RevisionDiff`, even when no feature has a comments, attachments, tags or revisions panel. Every feature's panel routes reference them (`$ref`), so their `paths` types are the same shapes as before, now `components['schemas'][…]`. The notes' `tags` field is a `TagRef` too.
