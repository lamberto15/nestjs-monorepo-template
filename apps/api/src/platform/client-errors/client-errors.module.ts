import { Module } from '@nestjs/common';
import { ClientErrorsService } from './client-errors.service.js';

/**
 * The client-errors capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [ClientErrorsService],
  exports: [ClientErrorsService],
})
export class ClientErrorsModule {}
