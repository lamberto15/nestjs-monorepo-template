import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/**
 * The settings capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Settings and flags: features declare them (options.settings) and read them through the service.
    SettingsService,
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
