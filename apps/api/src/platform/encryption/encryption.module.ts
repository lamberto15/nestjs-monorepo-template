import { Module } from '@nestjs/common';
import { ReencryptionService } from './reencryption.service.js';
import { ReencryptionProcessor } from './reencryption.processor.js';
import { ReencryptionScheduler } from './reencryption.scheduler.js';
import { ReencryptionMetrics } from './reencryption.metrics.js';

/**
 * The encryption capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Encrypted columns onto the current keys (docs/encryption.md):
    // hourly scheduling, one batch per queue job, the stale rows on /metrics.
    ReencryptionService,
    ReencryptionProcessor,
    ReencryptionScheduler,
    ReencryptionMetrics,
  ],
})
export class EncryptionModule {}
