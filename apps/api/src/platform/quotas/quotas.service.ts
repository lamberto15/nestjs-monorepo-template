import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  type TenantQuotaLimits,
  tenants,
} from '../../core/tenancy/tenancy.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  type QuotaResource,
  quotaOverride,
  TenantQuotas,
} from '../../core/tenancy/tenant-quotas.js';
import type { Principal } from '../../iam/auth/principal.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { SettingDeclaration } from '../settings/setting.types.js';
import type { TenantUsage, UpdateQuotas } from './quota.schemas.js';
import {
  QUOTA_MAX_API_CLIENTS,
  QUOTA_MAX_MEMBERS,
  QUOTA_MAX_RECORDS,
  QUOTA_MAX_STORAGE_BYTES,
} from './quota.settings.js';

const RECORDS = 'records:';

/**
 * Tenant limits for the operators and a tenant's administrators
 * (docs/tenancy.md, "Quotas"): what each tenant uses against what it may,
 * and the operators' per tenant limits. Enforcement is core's
 * (TenantQuotas.assertRoom(), called where the thing is made); this
 * registers the deployment's defaults, which are platform settings.
 */
@Injectable()
export class QuotasService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly quotas: TenantQuotas,
    private readonly tenancy: Tenancy,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {
    quotas.defaults((_tenantId, resource) =>
      this.settings.get(defaultOf(resource)),
    );
  }

  /** What a tenant uses and may use (a 404 for an unknown tenant). */
  async usage(tenantId: string): Promise<TenantUsage> {
    const [row] = await database(this.txHost)
      .select({ quotas: tenants.quotas })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!row) {
      throw new NotFoundException(`Tenant ${tenantId} not found.`);
    }
    // The counts read tenant tables: in that tenant's scope.
    return this.tenancy.run(tenantId, async () => {
      const db = database(this.txHost);
      const meter = async (resource: QuotaResource) => ({
        used: (await this.quotas.used(db, tenantId, resource)) ?? 0,
        limit: await this.quotas.limitOf(tenantId, resource, row.quotas),
      });
      const records: TenantUsage['records'] = {};
      for (const resource of this.quotas.resources()) {
        if (resource.startsWith(RECORDS)) {
          records[resource.slice(RECORDS.length)] = await meter(resource);
        }
      }
      return {
        tenantId,
        members: await meter('members'),
        apiClients: await meter('apiClients'),
        storageBytes: await meter('storageBytes'),
        records,
        limits: row.quotas,
      };
    });
  }

  /** The operators' limits for a tenant, merged into what it has; audited in both tenants. */
  async update(
    operator: Principal,
    tenantId: string,
    changes: UpdateQuotas,
    ip?: string,
  ): Promise<TenantUsage> {
    const { before, after, slug } = await inTransaction(
      this.txHost,
      async (tx) => {
        const [current] = await tx
          .select()
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .for('update');
        if (!current) {
          throw new NotFoundException(`Tenant ${tenantId} not found.`);
        }
        const next = merge(current.quotas, changes);
        await tx
          .update(tenants)
          .set({ quotas: next })
          .where(eq(tenants.id, tenantId));
        await this.audit.record(
          operator,
          changedEntry(tenantId, current.slug, current.quotas, next, ip),
          tx,
        );
        return { before: current.quotas, after: next, slug: current.slug };
      },
    );
    if (tenantId !== this.tenancy.current()?.tenantId) {
      await this.tenancy.run(tenantId, () =>
        this.audit.record(
          operator,
          changedEntry(tenantId, slug, before, after, ip),
        ),
      );
    }
    return this.usage(tenantId);
  }

  /** The resources of a limits object that differ, for the audit entry. */
  static resourcesOf(quotas: TenantQuotaLimits): QuotaResource[] {
    return [
      'members',
      'apiClients',
      'storageBytes',
      ...Object.keys(quotas.maxRecords ?? {}).map(
        (subject): QuotaResource => `records:${subject}`,
      ),
    ];
  }
}

function defaultOf(resource: QuotaResource): SettingDeclaration<number | null> {
  if (resource === 'members') return QUOTA_MAX_MEMBERS;
  if (resource === 'apiClients') return QUOTA_MAX_API_CLIENTS;
  if (resource === 'storageBytes') return QUOTA_MAX_STORAGE_BYTES;
  return QUOTA_MAX_RECORDS;
}

/** `null` removes a limit, a number sets it, an absent key stays. */
function merge(current: TenantQuotaLimits, changes: UpdateQuotas) {
  const next: TenantQuotaLimits = { ...current };
  for (const key of [
    'maxMembers',
    'maxApiClients',
    'maxStorageBytes',
  ] as const) {
    const value = changes[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  if (changes.maxRecords) {
    const records = { ...current.maxRecords };
    for (const [subject, value] of Object.entries(changes.maxRecords)) {
      if (value === null) delete records[subject];
      else records[subject] = value;
    }
    if (Object.keys(records).length > 0) next.maxRecords = records;
    else delete next.maxRecords;
  }
  return next;
}

function changedEntry(
  tenantId: string,
  slug: string,
  before: TenantQuotaLimits,
  after: TenantQuotaLimits,
  ip?: string,
) {
  const resources = new Set([
    ...QuotasService.resourcesOf(before),
    ...QuotasService.resourcesOf(after),
  ]);
  const changed = Object.fromEntries(
    [...resources]
      .map(
        (resource) =>
          [
            resource,
            {
              from: quotaOverride(before, resource) ?? null,
              to: quotaOverride(after, resource) ?? null,
            },
          ] as const,
      )
      .filter(([, change]) => change.from !== change.to),
  );
  return {
    action: 'tenant.quotas-changed',
    targetType: 'tenant',
    targetId: tenantId,
    details: { slug, ...changed },
    ip,
  };
}
