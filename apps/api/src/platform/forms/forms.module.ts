import { Module } from '@nestjs/common';
import { FormPolicy } from './form.policy.js';
import { FormsService } from './forms.service.js';
import { FormSubmissionsService } from './form-submissions.service.js';
import { FormOptionSourcesService } from './form-option-sources.service.js';
import { FormPublicLinksService } from './form-public-links.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AccountModule } from '../account/account.module.js';
import { ChoicesModule } from '../choices/choices.module.js';
import { RetentionModule } from '../retention/retention.module.js';

/**
 * The forms capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [SettingsModule, AccountModule, ChoicesModule, RetentionModule],
  providers: [
    // Runtime forms: definitions, published versions, submissions.
    FormPolicy,
    FormsService,
    FormSubmissionsService,
    FormOptionSourcesService,
    FormPublicLinksService,
  ],
  exports: [FormsService, FormSubmissionsService, FormPublicLinksService],
})
export class FormsModule {}
