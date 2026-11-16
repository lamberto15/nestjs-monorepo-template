import { Module } from '@nestjs/common';
import { TenantTransfer } from './tenant.transfer.js';
import { TenantExports } from './tenant-exports.service.js';
import { TenantCleanup } from './tenant-cleanup.js';
import { PlatformOpsModule } from '../ops/ops.module.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { TenantExportController } from './tenant-export.controller.js';

/**
 * The tenants capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformOpsModule, PlatformKernelModule],
  controllers: [
    // The operators' export of a tenant (POST /v1/tenants/{id}/export).
    TenantExportController,
  ],
  providers: [
    // A tenant's export (the operators'), and what its erase removes besides its rows.
    TenantTransfer,
    TenantExports,
    TenantCleanup,
  ],
  exports: [TenantExports],
})
export class TenantsModule {}
