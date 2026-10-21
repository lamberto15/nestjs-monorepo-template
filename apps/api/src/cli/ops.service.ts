import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  MfaService,
  PasswordHasher,
  SessionService,
  TokenService,
} from '@nestjs/authentication';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../core/database/drizzle.js';
import { tenants } from '../core/tenancy/tenancy.tables.js';
import { AccessService } from '../iam/access/access.service.js';
import { SystemContext } from '../iam/access/system-context.js';
import {
  ADMINISTRATOR_ROLE,
  TenantsService,
} from '../iam/access/tenants.service.js';
import { SecurityAlertsService } from '../iam/account/security-alerts.service.js';
import { AuditService } from '../iam/audit/audit.service.js';
import { DrizzleAuthenticationStore } from '../iam/auth/drizzle-authentication.store.js';
import {
  normalizeEmail,
  UsersRepository,
} from '../iam/auth/users.repository.js';
import {
  memberships,
  mfaAuthenticators,
  roles,
  userRoles,
  users,
} from '../iam/iam.tables.js';
import { mailSuppressions } from '../platform/deliverability/deliverability.tables.js';
import { SuppressionsService } from '../platform/deliverability/suppressions.service.js';
import { SettingsService } from '../platform/settings/settings.service.js';
import {
  platformSettingValues,
  settingOverrides,
} from '../platform/settings/settings.tables.js';
import type { Operator } from './operator.js';
import { OPS_JOB } from './ops.jobs.js';

/** A refusal for the person at the terminal: printed as it is, exit code 1. */
export class OpsError extends Error {}

/**
 * What a command will do, before it does it: `summary` is shown for
 * confirmation (`--yes` skips the question), `apply()` does it, once.
 */
export interface Plan<T> {
  summary: string[];
  apply(operator: Operator): Promise<T>;
}

/** A one-time password: shown once by the command, kept nowhere (only its hash is). */
export interface OneTimePassword {
  email: string;
  password: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 144 random bits as base64url: 24 characters, longer than any default policy asks. */
const oneTimePassword = () => randomBytes(18).toString('base64url');

/** The audit entries' `details.operator`: who ran the command, from where. */
const by = (operator: Operator) => ({
  operator: { user: operator.user, host: operator.host },
  via: 'cli',
});

/**
 * The operator CLI's logic (src/cli, docs/deployment.md, "Operator CLI"):
 * the break-glass commands as plans over the app's own services, so a
 * password is hashed, sessions and tokens ended, a setting removed and the
 * abilities dropped as the API does it. Every write runs as the system
 * principal `system:ops` (OPS_JOB) in the tenant it is about (docs/tenancy.md,
 * "The tenant of the work"), in one transaction with its audit entry, which
 * names the operator's OS user and host.
 *
 * What it prints is the commands' business; this class returns data and
 * never logs a password.
 */
@Injectable()
export class OpsService {
  constructor(
    private readonly system: SystemContext,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly tenantsService: TenantsService,
    private readonly hasher: PasswordHasher,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Work on global tables (accounts, tenants, memberships), in no tenant: a context of its own, as every read here needs. */
  private global<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.system.run(OPS_JOB, (_system, tx) => work(tx), {
      tenantId: null,
    });
  }

  // Orientation

  /** Every tenant, with its active members. */
  async tenantList() {
    return this.system.run(
      OPS_JOB,
      async (_system, tx) => {
        const rows = await tx
          .select({
            id: tenants.id,
            slug: tenants.slug,
            name: tenants.name,
            active: tenants.active,
            operator: tenants.operator,
          })
          .from(tenants)
          .orderBy(asc(tenants.slug));
        const members = await tx
          .select({ tenantId: memberships.tenantId, members: count() })
          .from(memberships)
          .where(eq(memberships.active, true))
          .groupBy(memberships.tenantId);
        return rows.map((row) => ({
          ...row,
          members: members.find((m) => m.tenantId === row.id)?.members ?? 0,
        }));
      },
      { tenantId: null },
    );
  }

  /** A tenant's members, with their roles and whether two-factor is on. */
  async userList(tenantRef: string) {
    const tenant = await this.tenant(tenantRef);
    return this.system.run(
      OPS_JOB,
      async (_system, tx) => {
        const members = await tx
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            accountActive: users.active,
            membershipActive: memberships.active,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.tenantId, tenant.id))
          .orderBy(asc(users.email));
        const ids = members.map((member) => member.id);
        // Tenant tables (roles): read in the tenant's scope.
        const grants = ids.length
          ? await tx
              .select({
                userId: userRoles.userId,
                key: roles.key,
                name: roles.name,
              })
              .from(userRoles)
              .innerJoin(roles, eq(roles.id, userRoles.roleId))
              .where(inArray(userRoles.userId, ids))
          : [];
        const enrolled = ids.length
          ? await tx
              .select({ userId: mfaAuthenticators.userId })
              .from(mfaAuthenticators)
              .where(
                and(
                  inArray(mfaAuthenticators.userId, ids),
                  eq(mfaAuthenticators.confirmed, true),
                ),
              )
          : [];
        return {
          tenant,
          members: members.map((member) => ({
            ...member,
            roles: grants
              .filter((grant) => grant.userId === member.id)
              .map((grant) => grant.key ?? grant.name),
            mfa: enrolled.some((row) => row.userId === member.id),
          })),
        };
      },
      { tenantId: tenant.id },
    );
  }

  // Changes

  /**
   * A first or extra administrator of a tenant. A new address gets an
   * account with a one-time password (verified: the operator vouches for
   * it); an existing account keeps its password and joins the tenant as
   * its administrator.
   */
  async adminCreate(
    emailInput: string,
    options: { tenant?: string; name?: string } = {},
  ): Promise<
    Plan<{
      tenant: string;
      created: boolean;
      changed: boolean;
      password?: OneTimePassword;
    }>
  > {
    const email = this.email(emailInput);
    const tenant = await this.tenant(options.tenant);
    const existing = await this.global(() => this.users.findByEmail(email));
    if (existing && !existing.active) {
      throw new OpsError(
        `The account ${email} is deactivated: nothing to make an administrator of.`,
      );
    }
    const already = existing
      ? await this.isAdministrator(tenant.id, existing.id)
      : false;
    const summary = [
      existing
        ? already
          ? `${email} is an administrator of "${tenant.slug}" already: nothing will change.`
          : `Make the existing account ${email} an administrator of "${tenant.slug}" (its password is kept).`
        : `Create the account ${email} (verified) and make it an administrator of "${tenant.slug}", with a one-time password shown once.`,
    ];
    if (!tenant.active) {
      summary.push(
        `Note: "${tenant.slug}" is deactivated: nobody can act in it until it is activated.`,
      );
    }
    return {
      summary,
      apply: (operator) =>
        this.system.run(
          OPS_JOB,
          async (system, tx) => {
            if (already) {
              return { tenant: tenant.slug, created: false, changed: false };
            }
            let userId = existing?.id;
            let password: OneTimePassword | undefined;
            if (!userId) {
              const generated = oneTimePassword();
              const created = await this.users.create(tx, {
                email,
                name: options.name?.trim() || email.split('@')[0]!,
                passwordHash: await this.hasher.hash(generated),
                emailVerified: true,
              });
              userId = created.id;
              password = { email, password: generated };
            }
            await this.tenantsService.addAdministrator(tx, userId);
            await this.audit.record(
              system,
              {
                action: 'ops.admin-created',
                targetType: 'user',
                targetId: userId,
                details: { email, newAccount: !existing, ...by(operator) },
              },
              tx,
            );
            this.access.invalidate();
            return {
              tenant: tenant.slug,
              created: !existing,
              changed: true,
              password,
            };
          },
          { tenantId: tenant.id },
        ),
    };
  }

  /** A one-time password for an account, and every session and token of it ended. */
  async resetPassword(emailInput: string): Promise<Plan<OneTimePassword>> {
    const email = this.email(emailInput);
    const user = await this.account(email);
    const summary = [
      `Set a new one-time password for ${email} (${user.name}), shown once.`,
      'Every session and token client of the account is signed out.',
    ];
    if (!user.active) {
      summary.push(
        'Note: the account is deactivated and stays so; it still can not sign in.',
      );
    }
    return {
      summary,
      apply: async (operator) => {
        const password = oneTimePassword();
        const hash = await this.hasher.hash(password);
        const told = await this.system.run(
          OPS_JOB,
          async (system, tx) => {
            await this.users.replacePassword(user.id, hash, tx);
            return this.alerts().credentialsChanged(tx, system, user.id, {
              action: 'ops.password-reset',
              ip: '',
              type: 'security.passwordChanged',
              data: { via: 'reset' },
              details: by(operator),
            });
          },
          { tenantId: null },
        );
        // The package's stores, outside transactions, as the API ends them.
        await this.sessions.revokeAll(user.id);
        await this.tokens.revokeAll(user.id);
        if (told) {
          this.alerts().deliverNow();
        }
        return { email, password };
      },
    };
  }

  /** Removes the authenticator and the recovery codes; ends the tokens that claim the second factor. */
  async removeMfa(
    emailInput: string,
  ): Promise<Plan<{ email: string; had: boolean }>> {
    const email = this.email(emailInput);
    const user = await this.account(email);
    const had = await this.global(() => this.mfa.isEnrolled(user.id));
    return {
      summary: [
        had
          ? `Remove the authenticator and the recovery codes of ${email}, and revoke its token clients' tokens.`
          : `${email} has no authenticator: only the failed-code counter is cleared.`,
        'Sessions stay: sign-in then asks for the password only (unless auth.requireMfa asks for enrolment).',
      ],
      apply: async (operator) => {
        const told = await this.system.run(
          OPS_JOB,
          async (system, tx) => {
            await this.mfa.disable(user.id);
            await this.store().clearMfaFailures(user.id);
            return this.alerts().credentialsChanged(tx, system, user.id, {
              action: 'ops.mfa-removed',
              ip: '',
              type: 'security.mfaChanged',
              data: { enabled: false },
              details: { ...by(operator), had },
            });
          },
          { tenantId: null },
        );
        await this.tokens.revokeAll(user.id);
        if (told) {
          this.alerts().deliverNow();
        }
        return { email, had };
      },
    };
  }

  /** Clears the failed second-factor attempts (the lockout) and the address's mail suppression. */
  async unlock(
    emailInput: string,
  ): Promise<Plan<{ email: string; failures: number; suppressed: boolean }>> {
    const email = this.email(emailInput);
    const user = await this.account(email);
    const failures = await this.global(() =>
      this.store().countMfaFailures(user.id, 24 * 3_600_000, Date.now()),
    );
    const [suppression] = await this.global((tx) =>
      tx
        .select({ id: mailSuppressions.id, reason: mailSuppressions.reason })
        .from(mailSuppressions)
        .where(eq(mailSuppressions.address, email)),
    );
    return {
      summary: [
        `Clear ${failures} failed second-factor attempt(s) of ${email} (the 15-minute lockout).`,
        suppression
          ? `Take ${email} off the mail suppression list (${suppression.reason}): mail goes to it again.`
          : `${email} is not on the mail suppression list.`,
        'Per-address rate limits (Redis) lapse by themselves within minutes.',
      ],
      apply: async (operator) =>
        this.system.run(
          OPS_JOB,
          async (system, tx) => {
            await this.store().clearMfaFailures(user.id);
            if (suppression) {
              await this.moduleRef
                .get(SuppressionsService, { strict: false })
                .remove(system, suppression.id);
            }
            await this.audit.record(
              system,
              {
                action: 'ops.user-unlocked',
                targetType: 'user',
                targetId: user.id,
                details: {
                  email,
                  failuresCleared: failures,
                  suppressionRemoved: Boolean(suppression),
                  ...by(operator),
                },
              },
              tx,
            );
            return { email, failures, suppressed: Boolean(suppression) };
          },
          { tenantId: null },
        ),
    };
  }

  /**
   * Removes a stored setting value: a tenant's own (`tenant`: id or slug)
   * or the platform's. The settings service removes it (and drops the
   * caches); the declaration must exist.
   */
  async deleteSetting(
    key: string,
    where: { tenant?: string; platform?: boolean },
  ): Promise<Plan<{ removed: boolean }>> {
    if (Boolean(where.tenant) === Boolean(where.platform)) {
      throw new OpsError(
        'Name where: --tenant <id|slug> or --platform (exactly one).',
      );
    }
    const tenant = where.tenant ? await this.tenant(where.tenant) : undefined;
    const current = await this.system.run(
      OPS_JOB,
      async (_system, tx) => {
        if (!tenant) {
          const [row] = await tx
            .select()
            .from(platformSettingValues)
            .where(eq(platformSettingValues.key, key));
          return row;
        }
        const [row] = await tx
          .select()
          .from(settingOverrides)
          .where(
            and(
              eq(settingOverrides.key, key),
              eq(settingOverrides.scope, 'tenant'),
              eq(settingOverrides.scopeId, ''),
            ),
          );
        return row;
      },
      { tenantId: tenant?.id ?? null },
    );
    const scope = tenant ? `tenant "${tenant.slug}"` : 'the platform';
    const shown = current ? JSON.stringify(current.value) : undefined;
    return {
      summary: [
        current
          ? `Delete the value of "${key}" for ${scope}${shown ? ` (now ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown})` : ''}: the next scope's value, or the default, holds again.`
          : `"${key}" has no stored value for ${scope}: nothing will change.`,
      ],
      apply: (operator) =>
        this.system.run(
          OPS_JOB,
          async (system, tx) => {
            if (!current) {
              return { removed: false };
            }
            try {
              if (tenant) {
                await this.settings.unset(system, key, 'tenant', undefined);
              } else {
                await this.settings.unsetPlatform(system, key);
              }
            } catch (error) {
              throw new OpsError(
                error instanceof Error ? error.message : String(error),
              );
            }
            await this.audit.record(
              system,
              {
                action: 'ops.setting-deleted',
                targetType: 'setting',
                targetId: key,
                details: {
                  scope: tenant ? 'tenant' : 'platform',
                  tenant: tenant?.slug ?? null,
                  ...by(operator),
                },
              },
              tx,
            );
            return { removed: true };
          },
          { tenantId: tenant?.id ?? null },
        ),
    };
  }

  // Lookups

  private email(input: string) {
    const email = normalizeEmail(input);
    if (!EMAIL.test(email)) {
      throw new OpsError(`"${input}" is not an email address.`);
    }
    return email;
  }

  private async account(email: string) {
    const user = await this.global(() => this.users.findByEmail(email));
    if (!user) {
      throw new OpsError(`No account has the address ${email}.`);
    }
    return user;
  }

  /**
   * A tenant by id or slug. Without one: the only tenant there is
   * (TENANCY=single, or a deployment that has made no other), else a
   * refusal that lists them.
   */
  private tenant(ref?: string) {
    return this.global((tx) => this.findTenant(tx, ref));
  }

  private async findTenant(tx: Transaction, ref?: string) {
    const rows = await tx
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        active: tenants.active,
      })
      .from(tenants)
      .where(
        ref
          ? UUID.test(ref)
            ? eq(tenants.id, ref)
            : eq(tenants.slug, ref)
          : sql`true`,
      )
      .orderBy(asc(tenants.slug))
      .limit(ref ? 1 : 3);
    if (ref) {
      if (!rows[0]) {
        throw new OpsError(
          `No tenant has the id or slug "${ref}" (pnpm ops tenant:list).`,
        );
      }
      return rows[0];
    }
    if (rows.length !== 1) {
      throw new OpsError(
        rows.length
          ? 'The deployment has several tenants: name one with --tenant <id|slug> (pnpm ops tenant:list).'
          : 'The deployment has no tenant yet: start the API once, it makes the first.',
      );
    }
    return rows[0];
  }

  private async isAdministrator(tenantId: string, userId: string) {
    return this.system.run(
      OPS_JOB,
      async (_system, tx) => {
        const [row] = await tx
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(
            and(
              eq(userRoles.userId, userId),
              eq(roles.key, ADMINISTRATOR_ROLE),
            ),
          );
        return row !== undefined;
      },
      { tenantId },
    );
  }

  /** IAM keeps its security notifications to itself (not exported): found through the module graph. */
  private alerts() {
    return this.moduleRef.get(SecurityAlertsService, { strict: false });
  }

  /** The package's store (failed second-factor attempts). */
  private store() {
    return this.moduleRef.get(DrizzleAuthenticationStore, { strict: false });
  }
}
