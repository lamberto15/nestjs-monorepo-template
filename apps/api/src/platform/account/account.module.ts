import { Module } from '@nestjs/common';
import { PersonalDataRegistry } from './personal-data.registry.js';
import { AccountLifecycleService } from './account.service.js';
import { AvatarService } from './avatar.service.js';
import { ConsentKinds } from './consent-kinds.js';
import { deletionCancelLinksProvider } from './deletion-cancel-links.js';
import { AccountTransfer } from './account.transfer.js';
import { AccountDeletionJob } from './account-deletion.job.js';
import { AccountDeletionMail } from './account.mails.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import {
  AccountController,
  AccountDeletionLinkController,
  ConsentKindsController,
} from './account.controller.js';
import { AvatarController } from './avatar.controller.js';

/**
 * The account capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule],
  controllers: [
    AccountController,
    // The user's picture (PUT, DELETE /v1/account/avatar).
    AvatarController,
    AccountDeletionLinkController,
    ConsentKindsController,
  ],
  providers: [
    // A person's own account: their data (features register PersonalDataSources), its deletion, consents.
    PersonalDataRegistry,
    AccountLifecycleService,
    AvatarService,
    ConsentKinds,
    deletionCancelLinksProvider,
    AccountTransfer,
    AccountDeletionJob,
    AccountDeletionMail,
  ],
  exports: [
    PersonalDataRegistry,
    AccountLifecycleService,
    AvatarService,
    ConsentKinds,
  ],
})
export class AccountModule {}
