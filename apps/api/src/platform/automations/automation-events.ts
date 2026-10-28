import { z } from 'zod';
import { defineNotifications } from '../notifications/notification.types.js';

/** The webhook event a rule's `webhook` action sends to the API client it names. */
export const AUTOMATION_WEBHOOK_EVENT = 'automation.matched';

/**
 * What a rule's `notify` action tells (texts: `i18n/<locale>/notifications.json`,
 * under `automation`). The platform adds it to the features' types.
 */
export const AUTOMATION_NOTIFICATIONS = defineNotifications([
  {
    type: 'automation.notified',
    channels: { email: 'immediate', webhook: false },
    data: z.object({
      rule: z.string(),
      subject: z.string(),
      recordId: z.uuid(),
      title: z.string(),
    }),
  },
]);
