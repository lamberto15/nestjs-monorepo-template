import { Module } from '@nestjs/common';
import { ClientErrorsService } from './client-errors.service.js';
import { ClientErrorsController } from './client-errors.controller.js';

/**
 * The client-errors capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [
    // The web app's own unexpected errors (apps/web/src/lib/report-error.ts).
    ClientErrorsController,
  ],
  providers: [ClientErrorsService],
  exports: [ClientErrorsService],
})
export class ClientErrorsModule {}
