import { WorkflowSignal } from '@nestjs/workflows';

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

/** Sent by the example sender's webhook: publish now instead of waiting. The note id is its key. */
export const publishNow = new WorkflowSignal<{ eventId: string }>(
  'note.publish-now',
);
