import { Module } from '@nestjs/common';
import { ConfigBundlesService } from './config-bundles.service.js';
import { ConfigBundlePolicy } from './config-bundle.policy.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * The config-bundles capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  providers: [ConfigBundlesService, ConfigBundlePolicy],
  exports: [ConfigBundlesService],
})
export class ConfigBundlesModule {}
