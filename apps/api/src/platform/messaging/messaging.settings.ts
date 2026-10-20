import { defineSettings, flag } from '../settings/setting.types.js';

/**
 * The kill switch of SMS: on by default; an operator sets it off for every
 * tenant, enforced (`PUT /settings/messaging.sms/platform`), to stop all
 * sending at once when a pumping attack shows (docs/notifications.md,
 * "Push and SMS"). A tenant administrator may switch off their own tenant's.
 */
export const MESSAGING_SMS_ENABLED = flag({
  key: 'messaging.sms',
  label: 'Send SMS',
  description:
    'Whether SMS leaves for this tenant. The operators can switch it off for every tenant.',
  scopes: ['tenant'],
  default: true,
});

export const MESSAGING_SETTINGS = defineSettings([MESSAGING_SMS_ENABLED]);
