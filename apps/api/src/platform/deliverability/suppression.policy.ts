import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { SubjectDefinition } from '../../iam/access/permissions.js';
import type { Principal } from '../../iam/auth/principal.js';

/** The suppression list's subject (listed in PLATFORM_PERMISSIONS, ops.policy.ts). */
export const MAIL_SUPPRESSION_SUBJECT: SubjectDefinition = {
  label: 'Mail suppression list',
  conditions: {},
  actions: {
    view: {
      label: 'See the addresses mail is not sent to, and why',
      conditions: [],
    },
    manage: {
      label: 'Add an address to the suppression list, or remove one',
      conditions: [],
    },
  },
};

/** Users only (an administrator's job), never while acting as someone else. */
const manager = (user: Principal | null): user is Principal =>
  user?.kind === 'user' && !user.impersonator;

/** The suppression list (platform/deliverability): who reads and changes it. */
@Policy()
export class MailSuppressionPolicy {
  constructor(private readonly access: AccessService) {}

  async view(user: Principal | null) {
    return manager(user) && this.access.can(user, 'view', 'MailSuppression');
  }

  async manage(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manage', 'MailSuppression');
  }
}
