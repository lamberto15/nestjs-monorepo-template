import { Module } from '@nestjs/common';
import { QuotasService } from './quotas.service.js';
import { QuotaMetrics } from './quota.metrics.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  TenantQuotasController,
  OwnQuotasController,
} from './quotas.controller.js';

/**
 * The quotas capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  controllers: [
    // Tenants' use and limits (GET /v1/tenants/{id}/usage, PUT …/quotas, GET /v1/tenant/usage).
    TenantQuotasController,
    OwnQuotasController,
  ],
  providers: [
    // Tenant limits: the deployment's defaults (settings), the views, the storage gauges.
    QuotasService,
    QuotaMetrics,
  ],
  exports: [QuotasService],
})
export class QuotasModule {}
