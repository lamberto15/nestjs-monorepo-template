import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { systemPrincipal, type SystemPrincipal } from '../auth/principal.js';
import { PermissionCatalog } from './permission-catalog.js';
import type { SystemJobDefinition } from './permissions.js';

/**
 * The CLS key of the system principal the current context runs as. A
 * symbol: a dotted string key is a path in nestjs-cls, whose parent object
 * a nested (`inherit`) context shares, so an inner job would leak out.
 */
const SYSTEM = Symbol('iam.system');

/** How `SystemContext.run()` runs the work. */
export interface SystemRunOptions {
  /**
   * `true` (the default): the work is one transaction (joining the current
   * one), handed over as `tx`. `false`: none is opened, for a batch job
   * that commits in short transactions of its own (`inTransaction()`),
   * each still in the context.
   */
  transaction?: boolean;
  // Multi-tenancy (roadmap 1a) adds `tenantId` here: set in the context
  // next to the principal, read by the transaction adapter.
}

/**
 * Runs work as the system principal (docs/permissions.md, "The system
 * principal"): what seeds, cron jobs, the outbox relay's handlers and
 * workflow steps do without a user. One way in, so every such job has the
 * same actor (`system:<job>` in the audit log), the permissions its
 * declaration gives (`defineSystemJob()`, nothing implicit), and a CLS
 * context of its own (nestjs-cls' `ClsService.run()`, its way for work
 * outside a request), which tenancy (1a) extends with the tenant.
 *
 * ```ts
 * @Cron('50 3 * * *') @OnOneInstance({ key: 'platform:account-deletion' })
 * run() {
 *   return this.system.run(ACCOUNT_DELETION_JOB, async (system, tx) => {
 *     …
 *     await this.audit.record(system, { action: 'account.deleted', … }, tx);
 *   });
 * }
 * ```
 */
@Injectable()
export class SystemContext {
  constructor(
    private readonly cls: ClsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly catalog: PermissionCatalog,
  ) {}

  /** The system principal of a declared job; throws for one no `definePermissions({ systemJobs })` declares. */
  principal(job: SystemJobDefinition | string): SystemPrincipal {
    const key = typeof job === 'string' ? job : job.key;
    const declared = this.catalog.systemJob(key);
    if (!declared) {
      throw new Error(
        `System job "${key}" isn't declared: list it in a definePermissions({ systemJobs }).`,
      );
    }
    return systemPrincipal(declared);
  }

  /**
   * Runs `work` as the job's system principal, in a CLS context carrying
   * it (`current()`), in one transaction unless `{ transaction: false }`.
   * Nested runs see the inner job; the outer context is left as it was.
   */
  run<T>(
    job: SystemJobDefinition | string,
    work: (system: SystemPrincipal, tx: Transaction) => Promise<T>,
    options?: { transaction?: true },
  ): Promise<T>;
  run<T>(
    job: SystemJobDefinition | string,
    work: (system: SystemPrincipal) => Promise<T>,
    options: { transaction: false },
  ): Promise<T>;
  async run<T>(
    job: SystemJobDefinition | string,
    work: (system: SystemPrincipal, tx: Transaction) => Promise<T>,
    { transaction = true }: SystemRunOptions = {},
  ): Promise<T> {
    const system = this.principal(job);
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set(SYSTEM, system);
      return transaction
        ? inTransaction(this.txHost, (tx) => work(system, tx))
        : (work as (system: SystemPrincipal) => Promise<T>)(system);
    });
  }

  /** The system principal the current context runs as (inside `run()`), or undefined. */
  current(): SystemPrincipal | undefined {
    return this.cls.isActive()
      ? (this.cls.get(SYSTEM) as SystemPrincipal | undefined)
      : undefined;
  }
}
