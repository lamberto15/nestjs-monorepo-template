import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../database/transactions.js';
import { type TenantQuotaLimits, tenants } from './tenancy.tables.js';

/**
 * What a tenant's limits cap (docs/tenancy.md, "Quotas"): its active
 * members, API clients, stored bytes, the records of a feature
 * (`records:Note`, the permission subject), and the mail it queues a day
 * (`mailsPerDay`, enforced by the mail budget, not `assertRoom()`).
 */
export type QuotaResource =
  | 'members'
  | 'apiClients'
  | 'storageBytes'
  | 'mailsPerDay'
  | `records:${string}`;

/** How much of a resource a tenant uses; `db` reads in the tenant's scope. */
export type QuotaCounter = (
  db: Database | Transaction,
  tenantId: string,
) => Promise<number>;

/** The deployment's default limit of a resource, or null: unlimited (the `quotas.*` settings). */
export type QuotaDefaults = (
  tenantId: string,
  resource: QuotaResource,
) => Promise<number | null>;

/** The limit an operator set on the tenant for a resource, if any. */
export const quotaOverride = (
  quotas: TenantQuotaLimits,
  resource: QuotaResource,
): number | undefined => {
  if (resource === 'members') return quotas.maxMembers;
  if (resource === 'apiClients') return quotas.maxApiClients;
  if (resource === 'storageBytes') return quotas.maxStorageBytes;
  if (resource === 'mailsPerDay') return quotas.maxMailsPerDay;
  return quotas.maxRecords?.[resource.slice('records:'.length)];
};

/**
 * Tenant limits, enforced where the thing is made (an invitation's
 * acceptance, an upload, a new API client, a new record). The groups that
 * own a resource register how it is counted (`count()`); the platform
 * registers the deployment's defaults (`defaults()`); core knows neither.
 *
 * `assertRoom()` is race safe: it takes a transaction-level advisory lock
 * per tenant and resource, then counts and compares, so two parallel
 * requests serialize between the check and their commit and never both
 * pass the last place. Only the creating transactions of one tenant and
 * resource wait for each other; a tenant with no limit takes no lock.
 */
@Injectable()
export class TenantQuotas {
  private readonly counters = new Map<string, QuotaCounter>();
  private defaultLimits: QuotaDefaults | null = null;

  constructor(private readonly txHost: TransactionHost<DrizzleTransactions>) {}

  /** How a resource (or, for `records:`, one feature's) is counted. */
  count(resource: QuotaResource, counter: QuotaCounter) {
    this.counters.set(resource, counter);
  }

  /** The deployment's default limits (the platform's settings). */
  defaults(resolve: QuotaDefaults) {
    this.defaultLimits = resolve;
  }

  /** The resources that can be counted now, `records:` ones included. */
  resources(): QuotaResource[] {
    return [...this.counters.keys()] as QuotaResource[];
  }

  /** Current use of a resource; null when nothing counts it (its group isn't loaded). */
  used(
    db: Database | Transaction,
    tenantId: string,
    resource: QuotaResource,
  ): Promise<number> | null {
    return this.counters.get(resource)?.(db, tenantId) ?? null;
  }

  /** The tenant's limit: its own, else the default; null: unlimited. */
  async limit(
    tenantId: string,
    resource: QuotaResource,
    db: Database | Transaction = database(this.txHost),
  ): Promise<number | null> {
    const [row] = await db
      .select({ quotas: tenants.quotas })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return this.limitOf(tenantId, resource, row?.quotas ?? {});
  }

  /** As `limit()`, for a row already read. */
  async limitOf(
    tenantId: string,
    resource: QuotaResource,
    quotas: TenantQuotaLimits,
  ): Promise<number | null> {
    return (
      quotaOverride(quotas, resource) ??
      (await this.defaultLimits?.(tenantId, resource)) ??
      null
    );
  }

  /**
   * A 422 `quota_exceeded` when `adding` more of the resource would pass the
   * tenant's limit. Call it inside the transaction that makes the thing,
   * before the insert (it takes the lock, and the transaction's end
   * releases it). `tenantId` is the tenant the thing is made in: for the
   * tenant-table resources it is the scope's own.
   */
  async assertRoom(
    tx: Database | Transaction,
    tenantId: string,
    resource: QuotaResource,
    adding = 1,
  ): Promise<void> {
    const limit = await this.limit(tenantId, resource, tx);
    if (limit === null) {
      return;
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${tenantId}:${resource}`}, 0))`,
    );
    const used = await this.used(tx, tenantId, resource);
    if (used === null) {
      return;
    }
    if (used + adding > limit) {
      throw quotaExceeded(resource, limit, used);
    }
  }
}

export function quotaExceeded(
  resource: QuotaResource,
  limit: number,
  used: number,
) {
  const [name, subject] = resource.split(':');
  const what =
    name === 'members'
      ? 'members'
      : name === 'apiClients'
        ? 'API clients'
        : name === 'storageBytes'
          ? 'bytes of storage'
          : `${subject} records`;
  return new HttpException(
    {
      code: 'quota_exceeded',
      message: `The tenant is limited to ${limit} ${what} and uses ${used}. Ask the operators to raise the limit, or free some.`,
      quota: { resource, limit, used },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
