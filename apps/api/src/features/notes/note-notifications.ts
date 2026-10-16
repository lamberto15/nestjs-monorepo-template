import { z } from 'zod';
import { commentedData } from '../../platform/comments/comment-notifications.js';
import { defineNotifications } from '../../platform/notifications/notification.types.js';

/**
 * What note owners are told of (texts: `i18n/<locale>/notifications.json`,
 * under `note`). Handed to the platform in app.module.ts.
 */
export const NOTE_NOTIFICATIONS = defineNotifications([
  {
    type: 'note.published',
    channels: { email: 'immediate', webhook: true },
    data: z.object({ noteId: z.uuid(), title: z.string() }),
  },
  {
    // A watched note was changed (by someone else): bundled in a daily mail by default.
    type: 'note.changed',
    channels: { email: 'daily', webhook: true },
    data: z.object({ noteId: z.uuid(), title: z.string(), by: z.string() }),
  },
  {
    // Someone else commented on a watched note (platform/comments): bundled daily by default.
    type: 'note.commented',
    channels: { email: 'daily', webhook: true },
    data: commentedData,
  },
  {
    // Someone else deleted the owner's note: they can't switch this off.
    type: 'note.deleted',
    channels: { email: 'immediate', webhook: true },
    mandatory: true,
    data: z.object({ noteId: z.uuid(), title: z.string(), by: z.string() }),
  },
]);
