import { Module } from '@nestjs/common';
import { ConfigBundlesService } from './config-bundles.service.js';
import { ConfigBundlePolicy } from './config-bundle.policy.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ConfigBundlesController } from './config-bundles.controller.js';

/**
 * The config-bundles capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  controllers: [ConfigBundlesController],
  providers: [ConfigBundlesService, ConfigBundlePolicy],
  exports: [ConfigBundlesService],
})
export class ConfigBundlesModule {}
