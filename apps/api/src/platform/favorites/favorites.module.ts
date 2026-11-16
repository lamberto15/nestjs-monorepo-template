import { Module } from '@nestjs/common';
import { FavoritesService } from './favorites.service.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { AccountModule } from '../account/account.module.js';
import { ViewsModule } from '../views/views.module.js';
import { FavoritesController } from './favorites.controller.js';

/**
 * The favorites capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, AccountModule, ViewsModule],
  controllers: [FavoritesController],
  providers: [
    // Favorites: a person's pinned records, pages and saved views, in their order.
    FavoritesService,
  ],
  exports: [FavoritesService],
})
export class FavoritesModule {}
