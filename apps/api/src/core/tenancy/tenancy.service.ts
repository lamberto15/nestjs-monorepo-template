import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { asc, eq } from 'drizzle-orm';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { runsWorkers } from '../config/core.env.js';
import {
  database,
  type DrizzleTransactions,
} from '../database/transactions.js';
import {
  BYPASS,
  currentTenantScope,
  NO_TENANT,
  requireTenantId,
  TENANT_SCOPE,
  type TenantScope,
  tenantScope,
} from './tenant-scope.js';
import { type Tenant, tenants } from './tenancy.tables.js';

/**
 * The tenant of the current work (docs/tenancy.md): set by PrincipalGuard
 * for requests and socket messages (from the principal's tenant), by the
 * processors from their jobs' envelopes, by `SystemContext.run(…, {
 * tenantId })` for a job's tenant, and read by the pool at the start of
 * every transaction. Features read `tenantId()` when they need the id (an
 * attachment key, a cache key); their inserts get it by themselves
 * (`tenantColumn()`).
 */
@Injectable()
export class Tenancy {
  private readonly logger = new Logger('Tenancy');

  constructor(
    private readonly cls: ClsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {}

  /** The scope of the current context, or undefined (no request, no job). */
  current(): TenantScope | undefined {
    return currentTenantScope();
  }

  /** The tenant of the current context, or a TenantScopeMissingError. */
  tenantId(where?: string): string {
    return requireTenantId(where);
  }

  /**
   * Runs `work` in `scope` (a tenant's id, or a scope), in a CLS context of
   * its own nested in the current one, which is left as it was. A request's
   * handler is already in its principal's tenant: this is for work that
   * starts outside one (a job restored from its envelope, an API key's
   * client loaded before the request has a tenant) or that walks several
   * (`forEachTenant()`).
   *
   * Refused inside an open transaction with other settings: the
   * transaction's settings were fixed when it began, so the inner work
   * would run in the outer tenant. Start the transaction inside instead.
   */
  run<T>(scope: TenantScope | string, work: () => Promise<T>): Promise<T> {
    const resolved = typeof scope === 'string' ? tenantScope(scope) : scope;
    if (this.cls.isActive() && this.txHost.isTransactionActive()) {
      const outer = currentTenantScope();
      if (!sameScope(outer, resolved)) {
        throw new Error(
          `A transaction for ${describe(outer)} is open: work for ${describe(resolved)} must start its own, outside it.`,
        );
      }
    }
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set(TENANT_SCOPE, resolved);
      return work();
    });
  }

  /** Runs `work` with no tenant: global tables only (a sign-in's lookups, an account's own data). */
  none<T>(work: () => Promise<T>): Promise<T> {
    return this.run(NO_TENANT, work);
  }

  /**
   * Runs `work` across every tenant at once (`app.bypass_rls`): for a
   * worker's maintenance job that sweeps a table whole by age (retention),
   * never for a request. Refused in a process that runs no workers and
   * inside a request's context, so a route can't reach it by mistake; a
   * job that acts per tenant (and audits it) iterates them instead
   * (`forEachTenant()`). Logged with the job.
   */
  bypass<T>(job: string, work: () => Promise<T>): Promise<T> {
    if (!runsWorkers()) {
      throw new Error(
        `${job}: the row-level security bypass runs in a worker only (APP_ROLE worker or all).`,
      );
    }
    if (this.cls.isActive() && this.cls.get(CLS_REQ)) {
      throw new Error(
        `${job}: the row-level security bypass never runs inside a request.`,
      );
    }
    this.logger.log(`${job}: across every tenant (row-level security bypass)`);
    return this.run(BYPASS, work);
  }

  /** The active tenants, oldest first. Global: readable in any scope. */
  active(): Promise<Tenant[]> {
    return database(this.txHost)
      .select()
      .from(tenants)
      .where(eq(tenants.active, true))
      .orderBy(asc(tenants.createdAt), asc(tenants.id));
  }

  /** One tenant by id, active or not; undefined when there is none. */
  async find(id: string): Promise<Tenant | undefined> {
    const [row] = await database(this.txHost)
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    return row;
  }

  /**
   * Runs `work` once per active tenant, each in that tenant's scope (and,
   * when it opens one, its own transaction), and logs which tenant each run
   * was for: how maintenance jobs act per tenant (account deletions, the
   * recycle bins, the attachment sweep, scheduled reports). A tenant's
   * failure is logged and the others still run; then the first error is
   * thrown.
   */
  async forEachTenant<T>(
    job: string,
    work: (tenant: Tenant) => Promise<T>,
  ): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    let failure: unknown;
    for (const tenant of await this.active()) {
      try {
        const result = await this.run(tenant.id, () => work(tenant));
        results.set(tenant.id, result);
        this.logger.debug(`${job}: ran for tenant ${tenant.slug}`, {
          tenant: tenant.id,
        });
      } catch (error) {
        failure ??= error;
        this.logger.error(`${job}: failed for tenant ${tenant.slug}`, {
          tenant: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failure) {
      throw failure;
    }
    return results;
  }
}

const sameScope = (a: TenantScope | undefined, b: TenantScope) =>
  (a?.tenantId ?? null) === b.tenantId &&
  (a?.bypass ?? false) === b.bypass &&
  (a?.readTenants ?? []).join() === b.readTenants.join();

const describe = (scope: TenantScope | undefined) =>
  scope?.bypass
    ? 'every tenant'
    : scope?.tenantId
      ? `tenant ${scope.tenantId}`
      : 'no tenant';
