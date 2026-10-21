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
import { isPlaceholderEmail } from '../auth/onboarding.js';
import { normalizeEmail } from '../auth/users.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { BreachedPasswordsService } from '../account/breached-passwords.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { memberships, roles, userRoles, users } from '../iam.tables.js';
import { SEED_JOB } from '../iam.jobs.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ADMINISTRATOR_ROLE, TenantsService } from './tenants.service.js';
import { SystemContext } from './system-context.js';

// Moved to tenants.service.ts (every tenant gets the roles); kept here for imports.
export { ADMINISTRATOR_ROLE } from './tenants.service.js';

/**
 * On the first start: the first tenant (ADMIN_TENANT_NAME, the operators',
 * docs/tenancy.md) with Administrator and the roles the declarations seed
 * (`seedRoles`), and the first administrator, its member, from
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
    private readonly tenants: TenantsService,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  async onModuleInit() {
    // Every start after the first: seeded already, no lock taken.
    if ((await this.count(tenants)) > 0 && (await this.count(users)) > 0) {
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
    const onboarding = this.config.get('ADMIN_ONBOARDING', { infer: true });
    const tenantName = this.config.get('ADMIN_TENANT_NAME', { infer: true });
    // The first tenant: the operators' (docs/tenancy.md), with every role
    // and the first administrator, made in its own scope (TenantsService).
    const seeded = await this.system.run(
      SEED_JOB,
      async (system) => {
        let done = false;
        await this.tenants
          .create(
            { name: tenantName, slug: slugOf(tenantName), operator: true },
            null,
            async (tx, tenant) => {
              const [{ id }] = await tx
                .insert(users)
                .values({
                  email,
                  name: 'Administrator',
                  passwordHash,
                  emailVerified: true,
                  // The first sign-in must replace a placeholder address
                  // and a generated password (OnboardingGuard).
                  onboardingEmail: onboarding && isPlaceholderEmail(email),
                  onboardingPassword: onboarding && !configured,
                })
                .returning({ id: users.id });
              await tx
                .insert(memberships)
                .values({ tenantId: tenant.id, userId: id });
              const [administrator] = await tx
                .select({ id: roles.id })
                .from(roles)
                .where(eq(roles.key, ADMINISTRATOR_ROLE));
              await tx
                .insert(userRoles)
                .values({ userId: id, roleId: administrator!.id });
              await this.audit.record(
                system,
                {
                  action: 'user.seeded',
                  targetType: 'user',
                  targetId: id,
                  details: { email, tenant: tenant.slug },
                },
                tx,
              );
              done = true;
            },
            async (tx) => {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended('iam:seed', 0))`,
              );
              const [{ existing }] = await tx
                .select({ existing: count() })
                .from(tenants);
              const [{ existingUsers }] = await tx
                .select({ existingUsers: count() })
                .from(users);
              if (existing > 0 || existingUsers > 0) {
                throw new SeededAlready();
              }
            },
          )
          .catch((error: unknown) => {
            if (!(error instanceof SeededAlready)) {
              throw error;
            }
          });
        return done;
      },
      { transaction: false },
    );

    // After the commit, and only from the process that seeded.
    if (seeded) {
      this.logger.log(
        `Seeded the tenant "${tenantName}" and its roles: ${[
          'Administrator',
          ...this.catalog.seedRoles.map((role) => role.name),
        ].join(', ')}.`,
      );
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

  private async count(table: typeof tenants | typeof users) {
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
}

/** Another process seeded first: this one's transaction rolls back. */
class SeededAlready extends Error {}

/** A tenant's handle from its name: `Acme Corp` → `acme-corp`. */
export const slugOf = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tenant';
