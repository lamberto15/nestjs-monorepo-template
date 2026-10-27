import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  MAIL_DELIVERY_MODES,
  type MailDelivery,
} from '../../core/mail/mail-delivery.js';
import { defineSettings, setting } from '../settings/setting.types.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Which mail leaves (#618): `all`; `essential`, only the mail a person needs
 * to sign in or recover an account (`@EssentialMail()`: no notifications,
 * digests, reports or invitations); `off`, none. The operators set it for
 * every tenant, enforced (`PUT /settings/mail.delivery/platform`), to stop a
 * mail storm at once without a deploy (docs/notifications.md, "Stopping a
 * mail storm"). A tenant administrator may restrict their own tenant's.
 */
export const MAIL_DELIVERY_SETTING = setting({
  key: 'mail.delivery',
  label: 'Mail delivery',
  description:
    'Which mail leaves for this tenant: all, only essential (sign-in, password reset, verification), or none.',
  schema: z.enum(MAIL_DELIVERY_MODES),
  scopes: ['tenant'],
  default: 'all',
});

export const DELIVERABILITY_SETTINGS = defineSettings([MAIL_DELIVERY_SETTING]);

/** The core mail queue's MAIL_DELIVERY: the setting, in the current tenant. */
@Injectable()
export class MailDeliverySettings implements MailDelivery {
  constructor(private readonly settings: SettingsService) {}

  mode() {
    return this.settings.get(MAIL_DELIVERY_SETTING);
  }
}
