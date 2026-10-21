import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { sql } from 'drizzle-orm';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import { attachments } from '../attachments/attachments.tables.js';

/**
 * `tenant_storage_bytes{tenant}` and `tenant_storage_limit_bytes{tenant}` on
 * the workers' `/metrics` (docs/tenancy.md, "Quotas"): what each tenant
 * stores and the limit it has (only tenants with one). The alert
 * `TenantStorageNearLimit` compares them.
 */
@Injectable()
export class QuotaMetrics implements OnModuleInit {
  private readonly logger = new Logger('QuotaMetrics');

  constructor(
    private readonly metrics: MetricsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly quotas: TenantQuotas,
  ) {}

  onModuleInit() {
    const db = () => database(this.txHost);
    this.metrics.collect(
      'tenant_storage_bytes',
      'Bytes of attachments and issued documents a tenant stores.',
      async () => {
        const rows = await db()
          .select({
            slug: tenants.slug,
            bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::float8`,
          })
          .from(tenants)
          .leftJoin(attachments, sql`${attachments.tenantId} = ${tenants.id}`)
          .groupBy(tenants.slug);
        return rows.map((row) => ({
          labels: { tenant: row.slug },
          value: row.bytes,
        }));
      },
      ['tenant'],
      { acrossTenants: true },
    );
    this.metrics.collect(
      'tenant_storage_limit_bytes',
      'The storage limit of a tenant (only tenants that have one).',
      async () => {
        const rows = await db()
          .select({
            id: tenants.id,
            slug: tenants.slug,
            quotas: tenants.quotas,
          })
          .from(tenants);
        const samples: { labels: { tenant: string }; value: number }[] = [];
        for (const row of rows) {
          const limit = await this.quotas
            .limitOf(row.id, 'storageBytes', row.quotas)
            .catch((error: unknown) => {
              this.logger.warn(
                `The default storage limit could not be read: ${String(error)}`,
              );
              return row.quotas.maxStorageBytes ?? null;
            });
          if (limit !== null) {
            samples.push({ labels: { tenant: row.slug }, value: limit });
          }
        }
        return samples;
      },
      ['tenant'],
      { acrossTenants: true },
    );
  }
}
