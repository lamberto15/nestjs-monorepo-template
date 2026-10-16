import { Policy } from '@nestjs/authorization';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AccessService } from '../../iam/access/access.service.js';
import type {
  ConditionTemplate,
  SubjectDefinition,
} from '../../iam/access/permissions.js';
import { userOnly } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { approvalRequests } from './approvals.tables.js';

/** "Only approvals of one subject": an auditor of expenses reads expense approvals. */
const ofSubject: ConditionTemplate<{ subject: string }> = {
  label: 'Of one subject',
  description: 'Only approval requests about records of this subject (Note).',
  params: z.object({ subject: z.string().min(1).max(100) }),
  paramsInput: { name: 'subject', label: 'Subject', type: 'text' },
  casl: (_principal, params) => ({ subject: params.subject }),
  sql: (_principal, params) => eq(approvalRequests.subject, params.subject),
};

/**
 * Approvals in the platform's permissions (PLATFORM_PERMISSIONS). Taking
 * part needs none: anyone reads the requests they made or decide, and
 * deciding takes being assigned (or standing in), never a role alone.
 * These permissions are for those who oversee them.
 */
export const APPROVAL_SUBJECT: SubjectDefinition = {
  label: 'Approvals',
  conditions: { ofSubject },
  actions: {
    read: {
      label: "See every approval request, not only one's own",
      conditions: ['ofSubject'],
    },
    cancel: {
      label: "Cancel anyone's approval request",
      conditions: ['ofSubject'],
    },
    manage: {
      label:
        'Abandon an approved request whose outcome would not apply (POST /v1/approvals/{id}/abandon)',
      conditions: ['ofSubject'],
    },
    managePolicies: {
      label: 'Change approval policies (stages, approvers, deadlines)',
      conditions: [],
    },
  },
};

@Policy()
export class ApprovalAccessPolicy {
  constructor(private readonly access: AccessService) {}

  // Approval.read and Approval.cancel are checked on the request itself
  // (ApprovalsService: a SQL filter for lists, the row for one).

  /** Policies: users only, never while impersonating. */
  async managePolicies(user: Principal | null) {
    return (
      userOnly(user) &&
      !user.impersonator &&
      this.access.can(user, 'managePolicies', 'Approval')
    );
  }
}
