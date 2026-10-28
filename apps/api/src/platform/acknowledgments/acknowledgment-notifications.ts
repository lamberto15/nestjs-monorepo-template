import { z } from 'zod';
import { defineNotifications } from '../notifications/notification.types.js';

const data = z.object({
  attachmentId: z.uuid(),
  version: z.number().int(),
  name: z.string(),
  by: z.string(),
  dueAt: z.string().nullable(),
});

/** What the acknowledgments tool tells people (texts: `i18n/<locale>/notifications.json`, under `acknowledgment`). */
export const ACKNOWLEDGMENT_NOTIFICATIONS = defineNotifications([
  {
    // Someone asked the recipient to acknowledge a document.
    type: 'acknowledgment.requested',
    channels: { email: 'immediate', webhook: true },
    data,
  },
  {
    // A reminder to acknowledge, from the one who asked.
    type: 'acknowledgment.reminder',
    channels: { email: 'immediate', webhook: true },
    data,
  },
]);
