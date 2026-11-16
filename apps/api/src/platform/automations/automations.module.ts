import { Module } from '@nestjs/common';
import { AutomationsRegistry } from './automations.registry.js';
import { AutomationsService } from './automations.service.js';
import { AutomationRulePolicy } from './automation.policy.js';
import { AutomationRunHandler } from './automation-run.handler.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { TagsModule } from '../tags/tags.module.js';
import { AutomationsController } from './automations.controller.js';

/**
 * The automations capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, TagsModule],
  controllers: [
    // Tenant automation rules (docs/automations.md).
    AutomationsController,
  ],
  providers: [
    // Automation rules: features register an AutomationTarget (the `automation` capability); runs come through the outbox.
    AutomationsRegistry,
    AutomationsService,
    AutomationRulePolicy,
    AutomationRunHandler,
  ],
  exports: [AutomationsRegistry, AutomationsService],
})
export class AutomationsModule {}
