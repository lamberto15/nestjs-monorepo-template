import { Module } from '@nestjs/common';
import { TemplatesRegistry } from './templates.registry.js';
import { TemplatesService } from './templates.service.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { AccountModule } from '../account/account.module.js';

/**
 * The templates capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [CustomFieldsModule, AccountModule],
  providers: [
    // Record templates: values to prefill a create, checked again at preview (private, unit, tenant).
    TemplatesRegistry,
    TemplatesService,
  ],
  exports: [TemplatesRegistry, TemplatesService],
})
export class TemplatesModule {}
