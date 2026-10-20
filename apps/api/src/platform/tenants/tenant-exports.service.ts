import { Injectable } from '@nestjs/common';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { TenantsService } from '../../iam/access/tenants.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { DataTransferService } from '../data-transfer/data-transfer.service.js';
import type { TransferFormat } from '../data-transfer/data-transfer.types.js';
import { TENANT_EXPORT } from './tenant.transfer.js';

/** Starts a tenant's export for an operator (TenantExportController). */
@Injectable()
export class TenantExports {
  constructor(
    private readonly tenants: TenantsService,
    private readonly transfers: DataTransferService,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  /**
   * Queues the export (in the operator's tenant, as the operator: its file
   * and its status are theirs), then records it in the exported tenant's
   * own log too: its administrators see that the operators took a copy.
   * The operator's tenant has `data.export-started` (with the tenant) and,
   * when done, `data.exported`.
   */
  async start(
    operator: UserPrincipal,
    tenantId: string,
    format: TransferFormat,
    ip?: string,
  ) {
    const tenant = await this.tenants.get(tenantId);
    const started = await this.transfers.startExport(operator, {
      name: TENANT_EXPORT,
      format,
      filters: { tenantId },
      internal: true,
      details: { tenantId, slug: tenant.slug },
    });
    const entry = {
      action: 'tenant.export-requested',
      targetType: 'tenant',
      targetId: tenantId,
      details: { slug: tenant.slug, transferId: started.id, format },
      ip,
    };
    await this.audit.record(operator, entry);
    if (tenantId !== operator.tenantId) {
      await this.tenancy.run(tenantId, () =>
        this.audit.record(operator, entry),
      );
    }
    return started;
  }
}
