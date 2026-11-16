import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { SettingsController } from './settings.controller.js';

/**
 * The settings capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [SettingsController],
  providers: [
    // Settings and flags: features declare them (options.settings) and read them through the service.
    SettingsService,
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
