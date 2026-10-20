import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { MfaService } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  authenticationOf,
  type CredentialAuthentication,
} from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { users } from '../iam.tables.js';
import { ssoConnections, ssoExemptions, ssoPolicies } from './sso.tables.js';

/** The refusal's code (the problem's `code`). */
export const SSO_REQUIRED = 'sso_required';

/** Who signs in, as the sign-in routes know them. */
interface SigningIn {
  id: string;
  email: string;
}

/** The 403 of a tenant that requires SSO. */
export const ssoRequired = () =>
  new ForbiddenException({
    code: SSO_REQUIRED,
    message: t('auth.ssoRequired'),
  });

/**
 * "SSO required" (docs/auth.md, "SSO required"): a tenant whose members
 * act in it only through one of its own connections, save the break-glass
 * members it exempts. Enforced three ways, all here:
 *
 * - **Sign-in.** A password or passkey sign-in (session or tokens) lands in
 *   a tenant that allows it: the last chosen if it does, else the next of
 *   the user's tenants; 403 `sso_required` when none does, or when the
 *   tenant asked for (tokens) doesn't. An exempted member's use is audited.
 * - **Every request** (SsoRequiredGuard): a session or token in such a
 *   tenant not signed in through one of its connections is refused, so
 *   turning the policy on restricts sessions already open, a magic link or
 *   Google sign-in included, and a switch into the tenant too.
 * - **Lockout.** Turning it on needs an enabled connection, and an
 *   administrator who is signed in through one or is exempted.
 *
 * Custom: a tenant's rule about how its members authenticate; nothing in
 * @nestjs/authentication decides per tenant.
 */
@Injectable()
export class SsoPolicyService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly mfa: MfaService,
    private readonly config: ConfigService<IamEnv, true>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  // The tenant's administrators (current tenant)

  /** The policy and its exemptions. */
  async get() {
    const [policy] = await this.db
      .select()
      .from(ssoPolicies)
      .where(eq(ssoPolicies.tenantId, this.tenancy.tenantId()));
    return {
      requireSso: policy?.requireSso ?? false,
      updatedAt: policy?.updatedAt ?? null,
      exemptions: await this.exemptions(),
    };
  }

  /**
   * Turns "SSO required" on or off. On needs an enabled connection, and the
   * actor's own way back in: signed in through one of the tenant's
   * connections now, or exempted (409 `sso_lockout`).
   */
  async setRequired(
    actor: UserPrincipal,
    session: unknown,
    requireSso: boolean,
    ip?: string,
  ) {
    if (requireSso) {
      const [{ enabled }] = await this.db
        .select({ enabled: count() })
        .from(ssoConnections)
        .where(
          and(
            eq(ssoConnections.tenantId, this.tenancy.tenantId()),
            eq(ssoConnections.enabled, true),
          ),
        );
      if (enabled === 0) {
        throw new ConflictException({
          code: 'sso_connection_required',
          message: 'Turn a connection on before requiring SSO.',
        });
      }
      const way = await this.tenancy.run(this.tenancy.tenantId(), () =>
        this.wayIn(
          this.tenancy.tenantId(),
          actor.id,
          authenticationOf(session),
        ),
      );
      if (!way) {
        throw new ConflictException({
          code: 'sso_lockout',
          message:
            'Sign in through one of the connections first, or exempt yourself: else you would lock yourself out.',
        });
      }
    }
    return inTransaction(this.txHost, async (tx) => {
      const [before] = await tx
        .select()
        .from(ssoPolicies)
        .where(eq(ssoPolicies.tenantId, this.tenancy.tenantId()));
      const [row] = await tx
        .insert(ssoPolicies)
        .values({ requireSso })
        .onConflictDoUpdate({
          target: ssoPolicies.tenantId,
          set: { requireSso, updatedAt: new Date() },
        })
        .returning();
      await this.audit.record(
        actor,
        {
          action: 'sso.policy-updated',
          targetType: 'tenant',
          targetId: row.tenantId,
          details: {
            requireSso: { from: before?.requireSso ?? false, to: requireSso },
          },
          ip,
        },
        tx,
      );
      return {
        requireSso: row.requireSso,
        updatedAt: row.updatedAt,
        exemptions: await this.exemptions(),
      };
    });
  }

  /**
   * Exempts an active member (break-glass): their password and passkey
   * still sign in. They must have two-factor set up (409
   * `sso_exemption_needs_mfa`), so the way around the IdP is never a
   * password alone; with AUTH_MFA=off nobody can, and it isn't asked.
   */
  async exempt(
    actor: UserPrincipal,
    userId: string,
    reason: string,
    ip?: string,
  ) {
    const tenantId = this.tenancy.tenantId();
    const member = await this.users.findMember(tenantId, userId);
    if (!member?.active) {
      throw new NotFoundException(`User ${userId} not found.`);
    }
    if (
      this.config.get('AUTH_MFA', { infer: true }) &&
      !(await this.mfa.isEnrolled(userId))
    ) {
      throw new ConflictException({
        code: 'sso_exemption_needs_mfa',
        message:
          'Only a member with two-factor sign-in set up can be exempted: a password alone would get around the IdP.',
      });
    }
    await inTransaction(this.txHost, async (tx) => {
      await tx
        .insert(ssoExemptions)
        .values({ userId, reason, createdBy: actor.id })
        .onConflictDoUpdate({
          target: [ssoExemptions.tenantId, ssoExemptions.userId],
          set: { reason },
        });
      await this.audit.record(
        actor,
        {
          action: 'sso.exemption-granted',
          targetType: 'user',
          targetId: userId,
          details: { email: member.email, reason },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Ends an exemption. Not one's own while SSO is required and one's
   * session isn't an SSO one: that would be one's way back in (409
   * `sso_lockout`).
   */
  async removeExemption(
    actor: UserPrincipal,
    session: unknown,
    userId: string,
    ip?: string,
  ) {
    if (
      userId === actor.id &&
      (await this.allows(
        this.tenancy.tenantId(),
        actor.id,
        authenticationOf(session),
      )) === 'exempt'
    ) {
      throw new ConflictException({
        code: 'sso_lockout',
        message:
          'Sign in through one of the connections first: this exemption is how you are signed in.',
      });
    }
    await inTransaction(this.txHost, async (tx) => {
      const [removed] = await tx
        .delete(ssoExemptions)
        .where(
          and(
            eq(ssoExemptions.tenantId, this.tenancy.tenantId()),
            eq(ssoExemptions.userId, userId),
          ),
        )
        .returning();
      if (!removed) {
        throw new NotFoundException(`User ${userId} is not exempted.`);
      }
      await this.audit.record(
        actor,
        {
          action: 'sso.exemption-removed',
          targetType: 'user',
          targetId: userId,
          ip,
        },
        tx,
      );
    });
  }

  private async exemptions() {
    return this.db
      .select({
        userId: ssoExemptions.userId,
        email: users.email,
        name: users.name,
        reason: ssoExemptions.reason,
        createdBy: ssoExemptions.createdBy,
        createdAt: ssoExemptions.createdAt,
      })
      .from(ssoExemptions)
      .innerJoin(users, eq(users.id, ssoExemptions.userId))
      .where(eq(ssoExemptions.tenantId, this.tenancy.tenantId()))
      .orderBy(asc(ssoExemptions.createdAt));
  }

  // Enforcement (any tenant)

  /**
   * How the user may act in the tenant with this authentication: `free`
   * (SSO isn't required), `sso` (signed in through one of the tenant's
   * connections), `exempt` (break-glass), or false.
   */
  async allows(
    tenantId: string,
    userId: string,
    authentication: CredentialAuthentication | null,
  ): Promise<'free' | 'sso' | 'exempt' | false> {
    return this.tenancy.run(tenantId, async () => {
      // Its own row: a holding's scope may read its subsidiaries' too.
      const [policy] = await this.db
        .select({ requireSso: ssoPolicies.requireSso })
        .from(ssoPolicies)
        .where(eq(ssoPolicies.tenantId, tenantId));
      if (!policy?.requireSso) {
        return 'free';
      }
      return this.wayIn(tenantId, userId, authentication);
    });
  }

  /**
   * The user's way into a tenant that requires SSO (in its scope): `sso`
   * (signed in through one of its connections), `exempt`, or false.
   */
  private async wayIn(
    tenantId: string,
    userId: string,
    authentication: CredentialAuthentication | null,
  ): Promise<'sso' | 'exempt' | false> {
    // The session's provider is the connection's id; under the tenant's
    // row-level security, only its own connections are found.
    const provider = authentication?.provider;
    if (authentication?.method === 'sso' && provider && UUID.test(provider)) {
      const [connection] = await this.db
        .select({ id: ssoConnections.id })
        .from(ssoConnections)
        .where(
          and(
            eq(ssoConnections.tenantId, tenantId),
            eq(ssoConnections.id, provider),
          ),
        );
      if (connection) {
        return 'sso';
      }
    }
    const [exempted] = await this.db
      .select({ userId: ssoExemptions.userId })
      .from(ssoExemptions)
      .where(
        and(
          eq(ssoExemptions.tenantId, tenantId),
          eq(ssoExemptions.userId, userId),
        ),
      );
    return exempted ? 'exempt' : false;
  }

  /**
   * The tenant a password or passkey sign-in lands in: the user's last
   * chosen when it allows the method, else the next that does (in the
   * order of `GET /v1/auth/tenants`); null for a user of no tenant. 403
   * `sso_required` when each of their tenants requires SSO of them.
   */
  async signInTenant(user: SigningIn, method: string, ip: string) {
    const tenantIds = (await this.users.memberships(user.id)).map(
      (membership) => membership.id,
    );
    for (const tenantId of tenantIds) {
      const way = await this.allows(tenantId, user.id, null);
      if (way) {
        await this.recordExemptionUse(way, tenantId, user, method, ip);
        return tenantId;
      }
    }
    if (tenantIds.length > 0) {
      await this.refused(tenantIds[0], user, method, ip);
      throw ssoRequired();
    }
    return null;
  }

  /** The tenant a token sign-in asked for allows the method, or 403 `sso_required`. */
  async assertSignInTenant(
    user: SigningIn,
    tenantId: string,
    method: string,
    ip: string,
  ) {
    const way = await this.allows(tenantId, user.id, null);
    if (!way) {
      await this.refused(tenantId, user, method, ip);
      throw ssoRequired();
    }
    await this.recordExemptionUse(way, tenantId, user, method, ip);
  }

  private async recordExemptionUse(
    way: 'free' | 'sso' | 'exempt',
    tenantId: string,
    user: SigningIn,
    method: string,
    ip: string,
  ) {
    if (way !== 'exempt') {
      return;
    }
    await this.tenancy.run(tenantId, () =>
      this.audit.record(asActor(user), {
        action: 'sso.exemption-used',
        targetType: 'user',
        targetId: user.id,
        details: { method },
        ip,
      }),
    );
  }

  private async refused(
    tenantId: string,
    user: SigningIn,
    method: string,
    ip: string,
  ) {
    await this.tenancy.run(tenantId, () =>
      this.audit.record(asActor(user), {
        action: 'auth.sign-in-failed',
        targetType: 'user',
        targetId: user.id,
        details: { method, reason: SSO_REQUIRED },
        ip,
      }),
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The audit log's actor for someone signing in (no principal yet). */
const asActor = (user: SigningIn) =>
  ({ kind: 'user', id: user.id, email: user.email }) as UserPrincipal;
