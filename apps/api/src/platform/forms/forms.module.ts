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
import { FormsController } from './forms.controller.js';
import { FormSubmissionsController } from './form-submissions.controller.js';
import {
  FormPublicLinksController,
  PublicFormsController,
} from './form-public-links.controller.js';

/**
 * The forms capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [SettingsModule, AccountModule, ChoicesModule, RetentionModule],
  controllers: [
    // Runtime forms (docs/forms.md): off per tenant until `forms.enabled`.
    FormsController,
    FormSubmissionsController,
    FormPublicLinksController,
    // Filling in a public form without a sign-in (POST /v1/public/forms/open, /submit).
    PublicFormsController,
  ],
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
