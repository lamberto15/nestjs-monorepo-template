import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import { definePermissions } from '../../iam/access/permissions.js';
import { userOnly } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { APPROVAL_SUBJECT } from '../approvals/approval.policy.js';
import { PLATFORM_SYSTEM_JOBS } from '../platform.jobs.js';

/** The platform's permissions: the operations API (/ops), approvals; its system jobs. */
export const PLATFORM_PERMISSIONS = definePermissions({
  subjects: {
    Approval: APPROVAL_SUBJECT,
    Ops: {
      label: 'Operations',
      conditions: {},
      actions: {
        view: {
          label: 'See the outbox, dead letters and live events',
          conditions: [],
        },
        manage: { label: 'Requeue and purge dead letters', conditions: [] },
      },
    },
  },
  // Its cron jobs, the notification delivery and the approvals workflow (platform.jobs.ts).
  systemJobs: PLATFORM_SYSTEM_JOBS,
});

/** The operations API: outbox, dead letters, live events. */
@Policy()
export class OpsPolicy {
  constructor(private readonly access: AccessService) {}

  async view(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'view', 'Ops');
  }

  async manage(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'manage', 'Ops');
  }
}
