import { Module } from '@nestjs/common';
import { ViewsService } from './views.service.js';
import { AccountModule } from '../account/account.module.js';
import { ListsModule } from '../lists/lists.module.js';

/**
 * The views capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [AccountModule, ListsModule],
  providers: [
    // Saved views: a list's filters, sort and columns under a name (private, unit, tenant).
    ViewsService,
  ],
  exports: [ViewsService],
})
export class ViewsModule {}
