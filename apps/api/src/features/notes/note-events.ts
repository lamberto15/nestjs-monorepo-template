import { WorkflowSignal } from '@nestjs/workflows';
import { z } from 'zod';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { commentedData } from '../../platform/comments/comment-notifications.js';
import { defineDomainEvents } from '../../platform/events/domain-event.js';

/**
 * The domain events of notes, each declared once for the channels that carry
 * it (handed to the platform by notes.feature.ts): the webhooks API clients
 * may subscribe to, and what note owners are told of (notification texts:
 * `i18n/<locale>/notifications.json`, under `note`).
 */
export const NOTE_EVENTS = defineDomainEvents([
  { type: 'note.created', webhook: true },
  {
    type: 'note.published',
    webhook: true,
    notification: {
      channels: { email: 'immediate', webhook: true },
      data: z.object({ noteId: z.uuid(), title: z.string() }),
    },
  },
  {
    // A watched note was changed (by someone else): bundled in a daily mail by default.
    type: 'note.changed',
    notification: {
      channels: { email: 'daily', webhook: true },
      data: z.object({ noteId: z.uuid(), title: z.string(), by: z.string() }),
    },
  },
  {
    // Someone else commented on a watched note (platform/comments): bundled daily by default.
    type: 'note.commented',
    notification: {
      channels: { email: 'daily', webhook: true },
      data: commentedData,
    },
  },
  {
    // Someone else deleted the owner's note: they can't switch this off.
    type: 'note.deleted',
    webhook: true,
    notification: {
      channels: { email: 'immediate', webhook: true },
      mandatory: true,
      data: z.object({ noteId: z.uuid(), title: z.string(), by: z.string() }),
    },
  },
]);

/** The webhooks API clients may subscribe to for their notes. */
export type NoteEventType = Extract<
  (typeof NOTE_EVENTS)[number],
  { webhook: true }
>['type'];

/** The `data` of every note webhook. */
export interface NoteEvent {
  noteId: string;
  title: string;
}

/**
 * Sent by the example sender's webhook: publish now instead of waiting. The
 * note id is its key (one publication per note, and note ids are unique
 * across tenants); it names its tenant, as every signal does
 * (docs/tenancy.md). NotesService sends it only after finding the note in
 * that tenant's scope, so it reaches that tenant's publication alone.
 */
export const publishNow = new WorkflowSignal<
  { eventId: string } & TenantEnvelope
>('note.publish-now');

/** What a note's publication starts with: the note, and its tenant (docs/tenancy.md). */
export interface NotePublicationInput extends TenantEnvelope {
  noteId: string;
  tenantId: string;
}
