import {
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { roles, userRoles } from '../iam.tables.js';
import { PermissionCatalog } from './permission-catalog.js';

/**
 * TENANCY=single (docs/tenancy.md, "Single-tenant deployments"): the first
 * start's tenant is the deployment's only one. Making another is refused
 * (`assertMayCreate()`, in TenantsService.create(): the operators' route and
 * the demo seed alike), and an account made by a self sign-up joins it in
 * the transaction that makes the account (`newAccount()`), with
 * SIGN_UP_ROLES. Configuration, not a NestJS feature: nothing in @nestjs/*
 * decides who joins a tenant.
 */
@Injectable()
export class SingleTenant implements OnApplicationBootstrap {
  private readonly logger = new Logger('Tenancy');

  constructor(
    private readonly config: ConfigService<IamEnv, true>,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly accounts: UsersRepository,
    private readonly audit: AuditService,
    private readonly catalog: PermissionCatalog,
  ) {}

  /** Whether the deployment is single-tenant (TENANCY=single). */
  get enabled(): boolean {
    return this.config.get('TENANCY', { infer: true }) === 'single';
  }

  private get signUpRoles(): string[] {
    return this.config.get('SIGN_UP_ROLES', { infer: true });
  }

  /**
   * SIGN_UP_ROLES checked at start: declared seed roles only, so never
   * Administrator (an open sign-up must not hand out the tenant). After
   * bootstrap, so the first start's seeder has made the tenant: more than
   * one (a deployment switched from multi) is only warned about.
   */
  async onApplicationBootstrap() {
    const keys = this.signUpRoles;
    if (!this.enabled) {
      if (keys.length) {
        this.logger.warn(
          'SIGN_UP_ROLES is ignored with TENANCY=multi: sign-ups join no tenant.',
        );
      }
      return;
    }
    // The built-in Administrator is no seed role: refused here with the rest.
    const declared = new Set(this.catalog.seedRoles.map((role) => role.key));
    const unknown = keys.filter((key) => !declared.has(key));
    if (unknown.length) {
      throw new Error(
        `SIGN_UP_ROLES names roles no declaration seeds: ${unknown.join(', ')} (known: ${[...declared].join(', ') || 'none'}).`,
      );
    }
    const [{ total }] = await database(this.txHost)
      .select({ total: count() })
      .from(tenants);
    if (total > 1) {
      this.logger.warn(
        `TENANCY=single with ${total} tenants: sign-ups join the operator tenant, and no more can be made.`,
      );
    }
  }

  /**
   * In TenantsService.create()'s transaction: refused when the deployment
   * is single-tenant and has its tenant already (the first start makes it).
   */
  async assertMayCreate(tx: Transaction) {
    if (!this.enabled) {
      return;
    }
    const [{ total }] = await tx.select({ total: count() }).from(tenants);
    if (total > 0) {
      throw new ConflictException({
        code: 'single_tenant',
        message:
          'This deployment has one tenant (TENANCY=single): another can’t be made.',
      });
    }
  }

  /**
   * Makes a self sign-up's account with `create`, in one transaction. Single-
   * tenant: in the tenant's scope, where the account joins it with
   * SIGN_UP_ROLES and the joining is audited; otherwise in no tenant, as
   * before (invitations add people).
   */
  async newAccount<T extends UserPrincipal>(
    create: (tx: Transaction) => Promise<T>,
    ip?: string,
  ): Promise<T> {
    if (!this.enabled) {
      return inTransaction(this.txHost, create);
    }
    const { id: tenantId } = await this.tenant();
    return this.tenancy.run(tenantId, () =>
      inTransaction(this.txHost, async (tx) => {
        const account = await create(tx);
        await this.accounts.joinTenant(tx, tenantId, account.id);
        const keys = this.signUpRoles;
        const granted = keys.length
          ? await tx
              .select({ id: roles.id })
              .from(roles)
              .where(inArray(roles.key, keys))
          : [];
        if (granted.length) {
          await tx
            .insert(userRoles)
            .values(
              granted.map(({ id }) => ({ userId: account.id, roleId: id })),
            );
        }
        await this.audit.record(
          { ...account, tenantId },
          {
            action: 'user.joined',
            targetType: 'user',
            targetId: account.id,
            details: { via: 'sign-up', roleIds: granted.map(({ id }) => id) },
            ip,
          },
          tx,
        );
        return account;
      }),
    );
  }

  /**
   * The deployment's tenant: the operator tenant the first start made (what
   * sign-ups join, and what the demo seed fills).
   */
  async tenant(): Promise<{ id: string; name: string }> {
    const [tenant] = await database(this.txHost)
      .select({ id: tenants.id, name: tenants.name, active: tenants.active })
      .from(tenants)
      .where(eq(tenants.operator, true))
      .orderBy(asc(tenants.createdAt))
      .limit(1);
    if (!tenant?.active) {
      throw new Error(
        'TENANCY=single: the operator tenant is missing or deactivated; sign-ups have nowhere to join.',
      );
    }
    return { id: tenant.id, name: tenant.name };
  }
}
