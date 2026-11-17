import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import { definePermissions } from '../../iam/access/permissions.js';
import { userOnly } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { APPROVAL_SUBJECT } from '../approvals/approval.policy.js';
// capability:automations begin
import { AUTOMATION_RULE_SUBJECT } from '../automations/automation.policy.js';
// capability:automations end
// capability:data-quality begin
import { DATA_QUALITY_SUBJECT } from '../data-quality/data-quality.policy.js';
// capability:data-quality end
import { MAIL_SUPPRESSION_SUBJECT } from '../deliverability/suppression.policy.js';
// capability:forms begin
import { FORM_SUBJECT } from '../forms/form.policy.js';
// capability:forms end
import { PLATFORM_SYSTEM_JOBS } from '../platform.jobs.js';

/** The platform's permissions: the operations API (/ops), approvals, the suppression list; its system jobs. */
export const PLATFORM_PERMISSIONS = definePermissions({
  subjects: {
    Approval: APPROVAL_SUBJECT,
    // capability:automations begin
    AutomationRule: AUTOMATION_RULE_SUBJECT,
    // capability:automations end
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
    // The suppression list (platform/deliverability): the addresses mail is not sent to.
    MailSuppression: MAIL_SUPPRESSION_SUBJECT,
    // capability:data-quality begin
    // Data-quality findings and scans (platform/data-quality).
    DataQuality: DATA_QUALITY_SUBJECT,
    // capability:data-quality end
    // capability:forms begin
    // Runtime forms (platform/forms).
    Form: FORM_SUBJECT,
    // capability:forms end
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
