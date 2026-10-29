import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { SubjectDefinition } from '../../iam/access/permissions.js';
import { userOnly } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Automation rules in the platform's permissions (PLATFORM_PERMISSIONS).
 * Granted by no seed role: administrators have them, and choose whom else.
 */
export const AUTOMATION_RULE_SUBJECT: SubjectDefinition = {
  label: 'Automation rules',
  conditions: {},
  actions: {
    read: {
      label: 'See automation rules and their runs',
      conditions: [],
    },
    manage: {
      label:
        'Create, simulate, activate and disable automation rules (they run with your permissions)',
      conditions: [],
    },
  },
};

/** Users only; changing rules never while impersonating (a rule runs as who activates it). */
@Policy()
export class AutomationRulePolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'read', 'AutomationRule');
  }

  async manage(user: Principal | null) {
    return (
      user?.kind === 'user' &&
      !user.impersonator &&
      this.access.can(user, 'manage', 'AutomationRule')
    );
  }
}
