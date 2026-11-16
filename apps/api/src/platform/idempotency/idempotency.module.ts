import { Module } from '@nestjs/common';
import { DrizzleIdempotencyStore } from './drizzle-idempotency.store.js';

/**
 * The idempotency capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Idempotency records in idempotency_keys; registers itself with IdempotencyStorage.
    DrizzleIdempotencyStore,
  ],
})
export class PlatformIdempotencyModule {}
