import { Module } from '@nestjs/common';
import { DataQualityRegistry } from './data-quality.registry.js';
import { DataQualityService } from './data-quality.service.js';
import { DataQualityProcessor } from './data-quality.processor.js';
import { DataQualityPolicy } from './data-quality.policy.js';

/**
 * The data-quality capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Data-quality checks: records register a DataQualityTarget, scans run on the queue.
    DataQualityRegistry,
    DataQualityService,
    DataQualityProcessor,
    DataQualityPolicy,
  ],
  exports: [DataQualityRegistry, DataQualityService],
})
export class DataQualityModule {}
