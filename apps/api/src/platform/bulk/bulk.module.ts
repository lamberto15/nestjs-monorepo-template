import { Module } from '@nestjs/common';
import { BulkRegistry } from './bulk.registry.js';
import { BulkService } from './bulk.service.js';
import { BulkProcessor } from './bulk.processor.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { QueuesModule } from '../queues/queues.module.js';

/**
 * The bulk capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, QueuesModule],
  providers: [
    // Bulk operations: features register a BulkOperation and call BulkService.run().
    BulkRegistry,
    BulkService,
    BulkProcessor,
  ],
  exports: [BulkRegistry, BulkService],
})
export class BulkModule {}
