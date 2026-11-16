import { Module } from '@nestjs/common';
import { RetentionRegistry } from './retention.registry.js';
import { RetentionService } from './retention.service.js';
import { RetentionProcessor } from './retention.processor.js';
import { RetentionScheduler } from './retention.scheduler.js';
import { RetentionController } from './retention.controller.js';

/**
 * The retention capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [RetentionController],
  providers: [
    // Retention rules features declare, run nightly on a queue (docs/retention.md).
    RetentionRegistry,
    RetentionService,
    RetentionProcessor,
    RetentionScheduler,
  ],
  exports: [RetentionRegistry, RetentionService],
})
export class RetentionModule {}
