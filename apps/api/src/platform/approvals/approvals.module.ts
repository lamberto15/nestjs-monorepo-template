import { Module } from '@nestjs/common';
import { ApprovalInboxSource } from './approval.inbox.js';
import { ApprovalsRegistry } from './approvals.registry.js';
import { BUILT_IN_RULES } from './approval-rules.js';
import { ApprovalPoliciesService } from './approval-policies.service.js';
import { ApprovalEngine } from './approval-engine.service.js';
import { ApprovalWorkflow } from './approval.workflow.js';
import { ApprovalsService } from './approvals.service.js';
import { ApprovalDelegationsService } from './approval-delegations.service.js';
import { ApprovalAccessPolicy } from './approval.policy.js';
import { ApprovalMetrics } from './approval-metrics.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AccountModule } from '../account/account.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import {
  ApprovalDelegationsController,
  ApprovalPoliciesController,
} from './approval-admin.controllers.js';
import { ApprovalsController } from './approvals.controller.js';

/**
 * The approvals capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, SettingsModule, AccountModule, InboxModule],
  controllers: [
    // Before ApprovalsController: its /approvals/{id} would read `delegations` as an id.
    ApprovalDelegationsController,
    ApprovalPoliciesController,
    ApprovalsController,
  ],
  providers: [
    ApprovalInboxSource,
    // Approvals: features declare actions (options.approvals) and register their
    // handlers, rules, modes, conditions and listeners into ApprovalsRegistry.
    ApprovalsRegistry,
    ...BUILT_IN_RULES,
    ApprovalPoliciesService,
    ApprovalEngine,
    ApprovalWorkflow,
    ApprovalsService,
    ApprovalDelegationsService,
    ApprovalAccessPolicy,
    // Open and overdue requests on /metrics.
    ApprovalMetrics,
  ],
  exports: [
    ApprovalsRegistry,
    ApprovalPoliciesService,
    ApprovalsService,
    ApprovalDelegationsService,
  ],
})
export class ApprovalsModule {}
