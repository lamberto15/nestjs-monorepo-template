import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalsRegistry } from '../../platform/approvals/approvals.registry.js';
import {
  type ApprovalHandler,
  type ApprovalOutcome,
  defineApproval,
} from '../../platform/approvals/approval.types.js';
import { NotePublisher } from './note-publisher.service.js';
import { NOTE_PUBLISH_APPROVAL_FLAG } from './note-settings.js';
import { NotesService } from './notes.service.js';
import { noteSnapshot } from './note.resource.js';

/** What a publication request carries: the title the approvers see. */
const payload = z.object({ title: z.string().max(200) });
type Payload = z.infer<typeof payload>;

/**
 * Publishing a note can need approval (docs/approvals.md, the worked
 * example): when the notes.publishApproval flag is on for the note's
 * owner, the publication workflow asks for it instead of publishing, and
 * any editor but the owner decides. Administrators may change the policy
 * at runtime (PUT /v1/approvals/policies/Note.publish). Handed to
 * `PlatformModule.forRoot({ approvals })` in app.module.ts.
 */
export const NOTE_PUBLISH_APPROVAL = defineApproval({
  subject: 'Note',
  action: 'publish',
  label: 'Publish a note',
  description: 'An editor approves a note before it is published.',
  payload,
  setting: NOTE_PUBLISH_APPROVAL_FLAG,
  policy: {
    stages: [
      {
        name: 'Editor review',
        approvers: [{ type: 'role', role: 'editor' }],
        mode: { type: 'any' },
      },
    ],
  },
});

/**
 * The notes side of it: what the record is, and what approval does. The
 * handlers run as workflow steps, at least once: `publish()` only
 * publishes a draft, so a second run changes nothing.
 */
@Injectable()
export class NotePublishApproval implements ApprovalHandler<Payload> {
  readonly approval = NOTE_PUBLISH_APPROVAL;

  constructor(
    registry: ApprovalsRegistry,
    private readonly notes: NotesService,
    private readonly publisher: NotePublisher,
  ) {
    registry.handle(this);
  }

  /** For the `permission` rule and conditions: the note (a 404 when gone counts as none). */
  record(id: string) {
    return this.notes.findOne(id);
  }

  async describe(id: string, { title }: Payload) {
    return { title, link: `/notes/${id}` };
  }

  /** What is approved is the note as it is (never what a caller says it is). */
  async payload(id: string): Promise<Payload> {
    return { title: (await this.notes.findOne(id)).title };
  }

  /** The note's content, hashed: an edit that went around the lock isn't published as approved. */
  async fingerprint(id: string) {
    try {
      const note = await this.notes.findOne(id);
      return createHash('sha256')
        .update(JSON.stringify(noteSnapshot(note)))
        .digest('base64url');
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  }

  /** As the approvals workflow (`actor`, `system:approvals`): the audit's actor. */
  async onApproved({ request, actor }: ApprovalOutcome<Payload>) {
    await this.publisher.publish(request.recordId, actor);
  }
}
