import { Module } from '@nestjs/common';
import { ExampleSenderWebhookController } from './example-sender-webhook.controller.js';
import {
  NoteBatchPublicationWorkflow,
  NotePublicationWorkflow,
} from './note-publication.workflow.js';
import { NotePublisher } from './note-publisher.service.js';
import { NotePolicy } from './note.policy.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';
import { NotesDemo } from './notes.demo.js';
import { NoteSearch } from './note.search.js';
import { NoteTransfer } from './note.transfer.js';
import { NoteBulk } from './note.bulk.js';
import { NoteAttachments } from './note-attachments.js';
import { attachmentRoutes } from '../../platform/attachments/attachment.routes.js';
import { NoteComments } from './note-comments.js';
import { NoteAccess } from './note-access.js';
import { NoteSubscriptions } from './note-subscriptions.js';
import { commentRoutes } from '../../platform/comments/comment.routes.js';
import { NoteTags } from './note-tags.js';
import {
  NOTE_BULK_DOCS,
  NOTE_CAPABILITIES,
  NOTE_DOCUMENT_DOCS,
  NOTE_REVISION_DOCS,
  NOTE_ROUTES,
  NOTE_WATCH_DOCS,
} from './note.routes.js';
import { tagRoutes } from '../../platform/tags/tag.routes.js';
import { NoteRevisions } from './note-revisions.js';
import { revisionRoutes } from '../../platform/revisions/revision.routes.js';
import { bulkRoutes } from '../../platform/bulk/bulk.routes.js';
import { watchRoutes } from '../../platform/subscriptions/subscription.routes.js';
import { shareRoutes } from '../../platform/shares/share.routes.js';
import { NoteShares } from './note-shares.js';
import { NoteAutomation } from './note-automation.js';
import { noteBulkSchema, noteSchema } from './note.schemas.js';
import { NotePublishApproval } from './note-approvals.js';
import { NoteAi } from './note-ai.js';
import { NoteDocuments } from './note-documents.js';
import { documentRoutes } from '../../platform/documents/document.routes.js';
import { listSource } from '../../platform/lists/lists.registry.js';
import { NOTE_LIST, NOTE_VIEWS } from './note.list.js';

/**
 * The example feature, showing every tool in use: a policy with conditions
 * (note.policy.ts), lists filtered in SQL, an idempotent create, a durable
 * workflow, outgoing webhooks through the outbox, a verified incoming webhook,
 * the audit log, exports and imports (note.transfer.ts), bulk actions
 * (note.bulk.ts), a PDF of a note (note-documents.ts), and
 * notifications to the owner (note-events.ts). Its permissions, event types and incoming sender are
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
    bulkRoutes(NOTE_ROUTES, {
      name: 'notes',
      body: noteBulkSchema,
      docs: NOTE_BULK_DOCS,
    }),
    watchRoutes(NOTE_ROUTES, { docs: NOTE_WATCH_DOCS }),
    shareRoutes(NOTE_ROUTES),
  ],
  providers: [
    NotesDemo,
    NotesService,
    NotePublisher,
    NotePolicy,
    NotePublicationWorkflow,
    NoteBatchPublicationWorkflow,
    NoteTransfer,
    NoteSearch,
    NoteBulk,
    NoteAttachments,
    NoteComments,
    NoteAccess,
    NoteSubscriptions,
    NoteShares,
    NoteAutomation,
    NoteTags,
    NoteRevisions,
    NotePublishApproval,
    NoteAi,
    NoteDocuments,
    // GET /v1/lists/Note: the list described, and what notes take (a generated record's comes from recordParts).
    listSource('Note', NOTE_LIST, NOTE_CAPABILITIES, NOTE_VIEWS),
  ],
  // The demo seed (src/demo) writes notes through it.
  exports: [NotesService, NotesDemo],
})
export class NotesModule {}
