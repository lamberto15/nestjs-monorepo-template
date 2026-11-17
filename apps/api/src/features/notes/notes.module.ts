import { Module } from '@nestjs/common';
import { recordParts } from '../../platform/records/record-parts.js';
import { ExampleSenderWebhookController } from './example-sender-webhook.controller.js';
// capability:ai begin
import { NoteAi } from './note-ai.js';
// capability:ai end
import { NoteBatch } from './note-batch.js';
import { NoteDocuments } from './note-documents.js';
import { NotePublishApproval } from './note-approvals.js';
import {
  NoteBatchPublicationWorkflow,
  NotePublicationWorkflow,
} from './note-publication.workflow.js';
import { NotePublisher } from './note-publisher.service.js';
import { NOTE_LIST } from './note.list.js';
import { NotePolicy } from './note.policy.js';
import { NOTE } from './note.record.js';
import { NOTE_SCHEMAS } from './note.schemas.js';
import { NoteTransfer } from './note.transfer.js';
import { NotesController } from './notes.controller.js';
import { NotesDemo } from './notes.demo.js';
import { NotesService } from './notes.service.js';
import { notes } from './notes.tables.js';

/** What the platform adds for its capabilities (note.record.ts): routes, targets, lifecycle, presenter. */
const parts = recordParts(NOTE, {
  service: NotesService,
  policy: NotePolicy,
  table: notes,
  list: NOTE_LIST,
  schemas: NOTE_SCHEMAS,
  // Imports and exports of notes match rows to notes and write them in groups; a note's PDF has a page of its own (documents/templates/note.html).
  override: { transfer: NoteTransfer, pdf: NoteDocuments },
});

/**
 * Notes, the example feature: a policy with conditions (note.policy.ts), a
 * durable publication workflow, outgoing webhooks through the outbox, a
 * verified incoming webhook, an approval before publishing, and notifications
 * to the owner (note-events.ts). Its record (note.record.ts) derives the rest.
 * Its permissions, event types and incoming sender are handed to IamModule
 * and PlatformModule in AppModule.
 */
@Module({
  controllers: [
    NotesController,
    ExampleSenderWebhookController,
    ...parts.controllers,
  ],
  providers: [
    NotesService,
    NotePolicy,
    NotesDemo,
    NoteBatch,
    NotePublisher,
    NotePublicationWorkflow,
    NoteBatchPublicationWorkflow,
    NotePublishApproval,
    // capability:ai begin
    NoteAi,
    // capability:ai end
    NoteDocuments,
    ...parts.providers,
  ],
  // The demo seed (src/demo) writes notes through it.
  exports: [NotesService, NotesDemo],
})
export class NotesModule {}
