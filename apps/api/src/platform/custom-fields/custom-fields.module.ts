import { Module } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomFieldPolicy } from './custom-field.policy.js';
import { CustomFieldsController } from './custom-fields.controller.js';

/**
 * The custom-fields capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [CustomFieldsController],
  providers: [
    // Custom fields: features declare their subjects (options.customFields) and inject the service.
    CustomFieldsService,
    CustomFieldPolicy,
  ],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
