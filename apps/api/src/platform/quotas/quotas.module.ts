import { Module } from '@nestjs/common';
import { QuotasService } from './quotas.service.js';
import { QuotaMetrics } from './quota.metrics.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * The quotas capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  providers: [
    // Tenant limits: the deployment's defaults (settings), the views, the storage gauges.
    QuotasService,
    QuotaMetrics,
  ],
  exports: [QuotasService],
})
export class QuotasModule {}
