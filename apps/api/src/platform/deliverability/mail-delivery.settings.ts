import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  MAIL_DELIVERY_MODES,
  type MailBudget,
  type MailDelivery,
} from '../../core/mail/mail-delivery.js';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { defineSettings, setting } from '../settings/setting.types.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Which mail leaves (#618): `all`; `essential`, only the mail a person needs
 * to sign in or recover an account (`@EssentialMail()`: no notifications,
 * digests, reports or invitations; a `mandatory` notification type's mail
 * is essential); `off`, none. It replaced `notifications.emailPolicy`. The operators set it for
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
  public: false,
  default: 'all',
});

/**
 * The deployment's mail budget (#618): mails queued per UTC day across every
 * tenant, the provider's quota; null: none. The operators set it
 * (`PUT /settings/mail.dailyLimit/platform`); no scope, a tenant can't change
 * it. A tenant's own budget is its `maxMailsPerDay` quota.
 */
export const MAIL_DAILY_LIMIT_SETTING = setting({
  key: 'mail.dailyLimit',
  label: 'Mails per day',
  description:
    'Mails queued per UTC day for the whole deployment (the mail provider’s quota); empty: no limit.',
  schema: z.number().int().min(0).nullable(),
  default: null as number | null,
  scopes: [],
  public: false,
});

/** Past this share of a daily budget (the deployment's or a tenant's), only essential mail goes. */
export const MAIL_ESSENTIAL_ONLY_PERCENT_SETTING = setting({
  key: 'mail.essentialOnlyPercent',
  label: 'Essential mail only from (%)',
  description:
    'Past this share of a daily mail limit, only essential mail (sign-in, password reset, verification) is sent.',
  schema: z.number().int().min(1).max(100),
  default: 90,
  scopes: [],
  public: false,
});

export const DELIVERABILITY_SETTINGS = defineSettings([
  MAIL_DELIVERY_SETTING,
  MAIL_DAILY_LIMIT_SETTING,
  MAIL_ESSENTIAL_ONLY_PERCENT_SETTING,
]);

/** The core mail queue's MAIL_DELIVERY: the settings and quota, in the current tenant. */
@Injectable()
export class MailDeliverySettings implements MailDelivery {
  constructor(
    private readonly settings: SettingsService,
    private readonly quotas: TenantQuotas,
  ) {}

  mode() {
    return this.settings.get(MAIL_DELIVERY_SETTING);
  }

  async budget(): Promise<MailBudget> {
    const tenantId = currentTenantId();
    const [daily, essentialOnlyPercent, tenantDaily] = await Promise.all([
      this.settings.get(MAIL_DAILY_LIMIT_SETTING),
      this.settings.get(MAIL_ESSENTIAL_ONLY_PERCENT_SETTING),
      tenantId ? this.quotas.limit(tenantId, 'mailsPerDay') : null,
    ]);
    return { daily, tenantDaily, essentialOnlyPercent };
  }
}
