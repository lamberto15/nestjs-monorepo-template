import { Module } from '@nestjs/common';
import { ModeService } from './mode.service.js';
import { PlatformOpsModule } from '../ops/ops.module.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * The mode capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformOpsModule, SettingsModule],
  providers: [
    // platform.mode / APP_MODE: read-only and maintenance (docs/settings.md).
    ModeService,
  ],
  exports: [ModeService],
})
export class ModeModule {}
