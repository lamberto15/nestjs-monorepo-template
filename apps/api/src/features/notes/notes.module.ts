import { Module } from '@nestjs/common';
import { ExampleSenderWebhookController } from './example-sender-webhook.controller.js';
import { NotePublicationWorkflow } from './note-publication.workflow.js';
import { NotePublisher } from './note-publisher.service.js';
import { NotePolicy } from './note.policy.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';
import { NoteSearch } from './note.search.js';
import { NoteTransfer } from './note.transfer.js';
import { NoteBulk } from './note.bulk.js';
import { NoteAttachments } from './note-attachments.js';
import { attachmentRoutes } from '../../platform/attachments/attachment.routes.js';
import { NoteComments } from './note-comments.js';
import { commentRoutes } from '../../platform/comments/comment.routes.js';
import { NoteTags } from './note-tags.js';
import {
  NOTE_DOCUMENT_DOCS,
  NOTE_REVISION_DOCS,
  NOTE_ROUTES,
} from './note.routes.js';
import { tagRoutes } from '../../platform/tags/tag.routes.js';
import { NoteRevisions } from './note-revisions.js';
import { revisionRoutes } from '../../platform/revisions/revision.routes.js';
import { noteSchema } from './note.schemas.js';
import { NotePublishApproval } from './note-approvals.js';
import { NoteDocuments } from './note-documents.js';
import { documentRoutes } from '../../platform/documents/document.routes.js';

/**
 * The example feature, showing every tool in use: a policy with conditions
 * (note.policy.ts), lists filtered in SQL, an idempotent create, a durable
 * workflow, outgoing webhooks through the outbox, a verified incoming webhook,
 * the audit log, exports and imports (note.transfer.ts), bulk actions
 * (note.bulk.ts), a PDF of a note (note-documents.ts), and
 * notifications to the owner (note-notifications.ts). Its permissions, event types and incoming sender are
 * handed to IamModule and PlatformModule in AppModule.
 *
 * To start a project: copy this folder as a model, then delete it (and its
 * lines in app.module.ts and schema.ts) and run `pnpm db:generate`.
 */
@Module({
  controllers: [
    NotesController,
    ExampleSenderWebhookController,
    commentRoutes(NOTE_ROUTES),
    attachmentRoutes(NOTE_ROUTES),
    tagRoutes(NOTE_ROUTES),
    revisionRoutes(NOTE_ROUTES, {
      restored: noteSchema,
      docs: NOTE_REVISION_DOCS,
    }),
    documentRoutes(NOTE_ROUTES, { source: 'note', docs: NOTE_DOCUMENT_DOCS }),
  ],
  providers: [
    NotesService,
    NotePublisher,
    NotePolicy,
    NotePublicationWorkflow,
    NoteTransfer,
    NoteSearch,
    NoteBulk,
    NoteAttachments,
    NoteComments,
    NoteTags,
    NoteRevisions,
    NotePublishApproval,
    NoteDocuments,
  ],
  // The demo seed (src/demo) writes notes through it.
  exports: [NotesService],
})
export class NotesModule {}
