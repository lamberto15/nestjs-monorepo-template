import { Module } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomFieldPolicy } from './custom-field.policy.js';

/**
 * The custom-fields capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Custom fields: features declare their subjects (options.customFields) and inject the service.
    CustomFieldsService,
    CustomFieldPolicy,
  ],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
