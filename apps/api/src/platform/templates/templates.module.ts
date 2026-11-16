import { Module } from '@nestjs/common';
import { TemplatesRegistry } from './templates.registry.js';
import { TemplatesService } from './templates.service.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { AccountModule } from '../account/account.module.js';
import { TemplatesController } from './templates.controller.js';

/**
 * The templates capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [CustomFieldsModule, AccountModule],
  controllers: [TemplatesController],
  providers: [
    // Record templates: values to prefill a create, checked again at preview (private, unit, tenant).
    TemplatesRegistry,
    TemplatesService,
  ],
  exports: [TemplatesRegistry, TemplatesService],
})
export class TemplatesModule {}
