import { ConflictException, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { PasswordResetService } from '@nestjs/authentication';
import { asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { rolePermissions, roles, userRoles } from '../iam.tables.js';
import { AccessService } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ALL, type SeedRole } from './permissions.js';

/** The built-in role's key (`roles.key`). */
export const ADMINISTRATOR_ROLE = 'administrator';

/** The built-in role of every tenant: the only one that can't be edited or deleted. */
export const ADMINISTRATOR: SeedRole & { system: true } = {
  key: ADMINISTRATOR_ROLE,
  name: 'Administrator',
  description:
    'Everything, including access control. Built in: can’t be changed or deleted.',
  system: true,
  permissions: [ALL],
};

export interface NewTenant {
  name: string;
  /** A short handle (`acme`): lowercase letters, digits and dashes. */
  slug: string;
  /** The deployment's operators (the first start's tenant only). */
  operator?: boolean;
}

/**
 * Makes tenants (docs/tenancy.md): the row, then, in the new tenant's own
 * scope and in one transaction with it, its roles (Administrator and every
 * declaration's `seedRoles`) and its first administrator's membership. The
 * first start makes the operator tenant through it (AccessSeeder); the
 * operators make the others (`POST /v1/tenants`). Who else may make one
 * (a self-service sign-up) is the owner's decision: roadmap 1b.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly catalog: PermissionCatalog,
    private readonly audit: AuditService,
    private readonly accounts: UsersRepository,
    private readonly passwordReset: PasswordResetService,
    private readonly access: AccessService,
  ) {}

  /** Every tenant, oldest first (the operators' list). */
  list(): Promise<Tenant[]> {
    return database(this.txHost)
      .select()
      .from(tenants)
      .orderBy(asc(tenants.createdAt), asc(tenants.id));
  }

  /**
   * A new tenant with its roles, and `administrator` (an account's id) as
   * its first administrator, all in one transaction run in the new tenant
   * (its id is drawn first, so the transaction starts with it: a
   * transaction's tenant is fixed when it begins). `work` runs last in the
   * same transaction (the first start's audit entry).
   */
  async create<T = void>(
    input: NewTenant,
    administrator: string | null,
    work?: (tx: Transaction, tenant: Tenant) => Promise<T>,
    /** Runs first in the transaction (the first start's lock and check). */
    first?: (tx: Transaction) => Promise<void>,
  ): Promise<{ tenant: Tenant; result: T | undefined }> {
    const id = await this.newId();
    return this.tenancy.run(id, () =>
      inTransaction(this.txHost, async (tx) => {
        await first?.(tx);
        const [tenant] = await tx
          .insert(tenants)
          .values({
            id,
            name: input.name,
            slug: input.slug,
            operator: input.operator ?? false,
          })
          .returning()
          .catch((error: unknown) => {
            if (codeOf(error) === '23505') {
              throw new ConflictException({
                code: 'tenant_slug_taken',
                message: `A tenant named "${input.slug}" exists.`,
              });
            }
            throw error;
          });
        await this.seedRoles(tx);
        if (administrator) {
          await this.accounts.addMembership(tx, id, administrator);
          const [role] = await tx
            .select({ id: roles.id })
            .from(roles)
            .where(eq(roles.key, ADMINISTRATOR_ROLE));
          await tx
            .insert(userRoles)
            .values({ userId: administrator, roleId: role!.id });
        }
        const result = work ? await work(tx, tenant!) : undefined;
        return { tenant: tenant!, result };
      }),
    );
  }

  /**
   * The operators' way: a tenant whose first administrator is the account
   * at `email` (made, and invited to choose a password, when there is none;
   * an unclaimed one loses its credentials first, as when any tenant adds
   * it). Audited in the new tenant and in the operator's own.
   */
  async createWithAdministrator(
    operator: Principal,
    input: NewTenant & { administratorEmail: string },
    ip?: string,
  ) {
    let account = await this.accounts.findByEmail(input.administratorEmail);
    if (account && !account.active) {
      throw new ConflictException('This account is closed.');
    }
    let invite = false;
    if (!account) {
      account = await inTransaction(this.txHost, (tx) =>
        this.accounts.create(tx, {
          email: input.administratorEmail,
          name: input.administratorEmail,
          passwordHash: null,
        }),
      );
      invite = true;
    }
    const administrator = account;
    const unclaimed = !administrator.emailVerified;
    const { tenant } = await this.create(
      { name: input.name, slug: input.slug },
      administrator.id,
      async (tx, created) => {
        if (unclaimed && !invite) {
          await this.accounts.resetCredentials(tx, administrator.id);
        }
        await this.audit.record(
          operator,
          {
            action: 'tenant.created',
            targetType: 'tenant',
            targetId: created.id,
            details: {
              slug: created.slug,
              administrator: administrator.email,
            },
            ip,
          },
          tx,
        );
      },
    );
    await this.audit.record(operator, {
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenant.id,
      details: { slug: tenant.slug, administrator: administrator.email },
      ip,
    });
    if (invite || unclaimed) {
      this.passwordReset.request(administrator.email);
    }
    this.access.invalidate();
    return tenant;
  }

  /** The tenant's roles: the built-in Administrator and the declarations' `seedRoles`. */
  private async seedRoles(tx: Transaction) {
    for (const role of [ADMINISTRATOR, ...this.catalog.seedRoles]) {
      const [row] = await tx
        .insert(roles)
        .values({
          key: role.key,
          name: role.name,
          description: role.description,
          system: 'system' in role,
        })
        .returning({ id: roles.id });
      if (role.permissions.length > 0) {
        await tx.insert(rolePermissions).values(
          role.permissions.map((permission) => ({
            roleId: row!.id,
            ...permission,
          })),
        );
      }
    }
  }

  /** A time-ordered id from PostgreSQL, as every row's (uuidv7()). */
  private async newId() {
    const result = await database(this.txHost).execute<{ id: string }>(
      sql`select uuidv7() as id`,
    );
    return (result as unknown as { rows: { id: string }[] }).rows[0]!.id;
  }
}

const codeOf = (error: unknown) =>
  (error as { code?: string })?.code ??
  (error as { cause?: { code?: string } })?.cause?.code;
