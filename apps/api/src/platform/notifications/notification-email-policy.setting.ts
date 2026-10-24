import { z } from 'zod';
import { defineSettings, setting } from '../settings/setting.types.js';

/** Deployment default for notification mail; tenants may override it. */
export const NOTIFICATION_EMAIL_POLICY = setting({
  key: 'notifications.emailPolicy',
  label: 'Notification email policy',
  public: false,
  description:
    'Essential only sends email for mandatory notification types. All follows each recipient’s notification email preferences.',
  schema: z.enum(['essential', 'all']),
  default: 'all',
});

export const NOTIFICATION_SETTINGS = defineSettings([
  NOTIFICATION_EMAIL_POLICY,
]);
