import { z } from 'zod';
import { defineNotifications } from '../notifications/notification.types.js';

/**
 * What the comments tool tells people itself (texts:
 * `i18n/<locale>/notifications.json`, under `comment`). The platform adds
 * these to the features' types. A record's watchers hear of a new comment
 * through the feature's own type (`note.commented`), with this `data`.
 */
export const COMMENT_NOTIFICATIONS = defineNotifications([
  {
    // Someone mentioned the recipient (`@ada@example.com`) in a comment on a record they may read.
    type: 'comment.mentioned',
    channels: { email: 'immediate', webhook: true },
    data: z.object({
      subject: z.string(),
      recordId: z.uuid(),
      commentId: z.uuid(),
      title: z.string(),
      by: z.string(),
      excerpt: z.string(),
    }),
  },
]);

/** The `data` of a feature's `<subject>.commented` type (`note.commented`). */
export const commentedData = z.object({
  recordId: z.uuid(),
  commentId: z.uuid(),
  title: z.string(),
  by: z.string(),
  excerpt: z.string(),
});
