import { randomBytes } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import type { IamEnv } from '../iam.env.js';
import { count, eq, sql } from 'drizzle-orm';
import { normalizeEmail } from '../auth/users.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { BreachedPasswordsService } from '../account/breached-passwords.service.js';
import { rolePermissions, roles, userRoles, users } from '../iam.tables.js';
import { SEED_JOB } from '../iam.jobs.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ALL, type SeedRole } from './permissions.js';
import { SystemContext } from './system-context.js';

/** The built-in role's key (`roles.key`). */
export const ADMINISTRATOR_ROLE = 'administrator';

/** The built-in role: the only one that can't be edited or deleted. */
const ADMINISTRATOR: SeedRole & { system: true } = {
  key: ADMINISTRATOR_ROLE,
  name: 'Administrator',
  description:
    'Everything, including access control. Built in: can’t be changed or deleted.',
  system: true,
  permissions: [ALL],
};

/**
 * On the first start: Administrator and the roles the declarations seed
 * (`seedRoles`), and the first administrator from
 * `ADMIN_EMAIL` and `ADMIN_PASSWORD` (a password is generated and logged once
 * when it isn't set). Later starts change nothing, so edits through the access API
 * stay. It runs as the system principal (`system:seed`, SEED_JOB), the
 * actor of its `user.seeded` audit entry.
 */
@Injectable()
export class AccessSeeder implements OnModuleInit {
  private readonly logger = new Logger('Access');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly passwordHasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly catalog: PermissionCatalog,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly system: SystemContext,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  async onModuleInit() {
    // Every start after the first: seeded already, no lock taken.
    if ((await this.count(roles)) > 0 && (await this.count(users)) > 0) {
      return;
    }
    // The first start of a deployment runs this in every process at once
    // (api replicas, the worker): checked and seeded under one advisory lock,
    // so exactly one of them seeds and the others find it done. Before, each
    // saw empty tables and the losers crashed on users_email_unique.
    const configured = this.config.get('ADMIN_PASSWORD', { infer: true });
    const password = configured || randomBytes(18).toString('base64url');
    // scrypt before the lock: the lock is held for milliseconds, not a hash.
    const passwordHash = await this.passwordHasher.hash(password);
    const email = normalizeEmail(
      this.config.get('ADMIN_EMAIL', { infer: true }),
    );
    const seeded = await this.system.run(SEED_JOB, async (system, tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('iam:seed', 0))`,
      );
      const done = { roles: false, administrator: false };
      const [{ existing }] = await tx.select({ existing: count() }).from(roles);
      if (existing === 0) {
        for (const role of this.seedRoles()) {
          const [row] = await tx
            .insert(roles)
            .values({
              key: role.key,
              name: role.name,
              description: role.description,
              system: 'system' in role,
            })
            .returning({ id: roles.id });
          await tx.insert(rolePermissions).values(
            role.permissions.map((permission) => ({
              roleId: row.id,
              ...permission,
            })),
          );
        }
        done.roles = true;
      }
      const [{ existingUsers }] = await tx
        .select({ existingUsers: count() })
        .from(users);
      if (existingUsers === 0) {
        const [{ id }] = await tx
          .insert(users)
          .values({
            email,
            name: 'Administrator',
            passwordHash,
            emailVerified: true,
          })
          .returning({ id: users.id });
        const [administrator] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.key, ADMINISTRATOR_ROLE));
        await tx
          .insert(userRoles)
          .values({ userId: id, roleId: administrator.id });
        await this.audit.record(
          system,
          {
            action: 'user.seeded',
            targetType: 'user',
            targetId: id,
            details: { email },
          },
          tx,
        );
        done.administrator = true;
      }
      return done;
    });

    // After the commit, and only from the process that seeded.
    if (seeded.roles) {
      this.logger.log(
        `Seeded the roles: ${this.seedRoles()
          .map((role) => role.name)
          .join(', ')}.`,
      );
    }
    if (seeded.administrator) {
      if (configured) {
        await this.warnIfBreached(password);
      }
      this.logger.warn(
        configured
          ? `Created the first administrator ${email} (password from ADMIN_PASSWORD).`
          : `Created the first administrator ${email} with password ${password} (shown once; set ADMIN_PASSWORD to choose it, and change it after signing in).`,
      );
    }
  }

  private async count(table: typeof roles | typeof users) {
    const [{ rows }] = await this.db.select({ rows: count() }).from(table);
    return rows;
  }

  /**
   * ADMIN_PASSWORD found in data breaches: a loud warning, not a refusal
   * (refusing would leave the deployment without an administrator, and a
   * start that depends on an outside API). Change it after signing in.
   */
  private async warnIfBreached(password: string) {
    if (await this.breachedPasswords.isBreached(password)) {
      this.logger.error(
        'ADMIN_PASSWORD is in known data breaches (Pwned Passwords): change it right after signing in, and in .env.',
      );
    }
  }

  private seedRoles(): SeedRole[] {
    return [ADMINISTRATOR, ...this.catalog.seedRoles];
  }
}
