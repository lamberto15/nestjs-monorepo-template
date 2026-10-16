import { WorkflowSignal } from '@nestjs/workflows';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';

/** The webhooks API clients may subscribe to for their notes. */
export const NOTE_EVENT_TYPES = [
  'note.created',
  'note.published',
  'note.deleted',
] as const;

export type NoteEventType = (typeof NOTE_EVENT_TYPES)[number];

/** The `data` of every note webhook. */
export interface NoteEvent {
  noteId: string;
  title: string;
}

/**
 * Sent by the example sender's webhook: publish now instead of waiting. The
 * note id is its key; it names its tenant, as every signal does
 * (docs/tenancy.md), and the workflow ignores one of another tenant.
 */
export const publishNow = new WorkflowSignal<
  { eventId: string } & TenantEnvelope
>('note.publish-now');

/** What a note's publication starts with: the note, and its tenant (docs/tenancy.md). */
export interface NotePublicationInput extends TenantEnvelope {
  noteId: string;
  tenantId: string;
}
