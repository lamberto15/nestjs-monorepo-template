import { Module } from '@nestjs/common';
import { ViewsService } from './views.service.js';
import { AccountModule } from '../account/account.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { ViewsController } from './views.controller.js';

/**
 * The views capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [AccountModule, ListsModule],
  controllers: [ViewsController],
  providers: [
    // Saved views: a list's filters, sort and columns under a name (private, unit, tenant).
    ViewsService,
  ],
  exports: [ViewsService],
})
export class ViewsModule {}
