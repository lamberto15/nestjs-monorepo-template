import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { SignInService } from '@nestjs/authentication';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, inArray, lte } from 'drizzle-orm';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { Transaction } from '../../core/database/drizzle.js';
import { SecurityAlertsService } from '../account/security-alerts.service.js';
import { AccessAdminService } from '../access/access-admin.service.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { methodMetadata } from '../auth/authentication-method.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import {
  memberships,
  userIdentities,
  userRoles,
  users,
} from '../iam.tables.js';
import { ssoRoleGrants, ssoRoleMappings } from './sso.tables.js';
import { emailDomain, SsoDomainsService } from './sso-domains.service.js';
import type { SsoConnection } from './sso-connections.service.js';

/** Who the IdP says signed in: from a verified ID token, a verified assertion, or an OAuth 2.0 provider's user-info answer. */
export interface SsoIdentity {
  /** The IdP's immutable subject (`sub`, the persistent NameID). */
  subject: string;
  email?: string;
  /**
   * The IdP asserted the address belongs to the person: OIDC's
   * `email_verified`; an OAuth 2.0 connection's mapping (a field that must
   * be true, or `verified-domains`); SAML has no such claim, and the
   * tenant's verified domain is what makes its word count.
   */
  emailVerified: boolean;
  name?: string;
  /** When the IdP authenticated the person, when it says (`auth_time`, `AuthnInstant`). */
  authenticatedAt?: Date;
  /** The groups the IdP lists (the connection's `groupsAttribute`), for its role mappings. */
  groups?: string[];
}

/** A sign-in refused: `reason` goes to the audit log, never to the browser. */
export class SsoRefused extends Error {
  constructor(readonly reason: string) {
    super(`SSO sign-in refused: ${reason}`);
    this.name = 'SsoRefused';
  }
}

/** The `user_identities` provider of a connection: namespaced, never shared between tenants. */
export const ssoProvider = (connectionId: string) => `sso:${connectionId}`;

/**
 * The account an SSO identity signs in to, in the connection's tenant
 * (docs/auth.md, "Enterprise SSO", "No account takeover"):
 *
 * - a known identity (`sso:<connection>` + subject): its account, while it
 *   is active, and its membership, unless deactivated (deprovisioned);
 * - else only an address of a domain the tenant verified, and, for OIDC
 *   and OAuth 2.0, one the IdP says is verified;
 * - an existing account with that address is linked only when its own
 *   address is proved (else someone who registered it first, with a
 *   password of their choosing, would get the person's sign-ins);
 * - no membership yet: one is made only with just-in-time provisioning on
 *   (and the account too, when the address has none).
 *
 * Then the roles the connection maps the IdP's groups to (`syncRoles()`),
 * and the session (`method: sso`, `provider: <connection id>`, in the
 * connection's tenant), audited and alerted as any sign-in.
 */
@Injectable()
export class SsoAccounts {
  private readonly logger = new Logger('SSO');

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly domains: SsoDomainsService,
    private readonly audit: AuditService,
    private readonly signInService: SignInService,
    private readonly securityAlerts: SecurityAlertsService,
    private readonly accessAdmin: AccessAdminService,
    private readonly access: AccessService,
  ) {}

  /** The account to sign in, or SsoRefused. Runs in the connection's tenant. */
  async resolve(connection: SsoConnection, identity: SsoIdentity) {
    const { userId, rolesChanged } = await this.resolveInTransaction(
      connection,
      identity,
    );
    if (rolesChanged) {
      this.access.invalidate();
    }
    return userId;
  }

  private async resolveInTransaction(
    connection: SsoConnection,
    identity: SsoIdentity,
  ) {
    const provider = ssoProvider(connection.id);
    const tenantId = connection.tenantId;
    return inTransaction(this.txHost, async (tx) => {
      const [known] = await tx
        .select({ userId: userIdentities.userId, active: users.active })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(
          and(
            eq(userIdentities.provider, provider),
            eq(userIdentities.subject, identity.subject),
          ),
        );
      if (known) {
        if (!known.active) {
          throw new SsoRefused('account_inactive');
        }
        const provisioned = await this.ensureMember(
          tx,
          connection,
          known.userId,
          identity,
        );
        return {
          userId: known.userId,
          rolesChanged: await this.syncRoles(
            tx,
            connection,
            known.userId,
            identity,
            provisioned,
          ),
        };
      }
      const email = identity.email ? normalizeEmail(identity.email) : undefined;
      if (!email) {
        throw new SsoRefused('no_email');
      }
      // Before `emailVerified` is read: `verified-domains` relies on it.
      if (!(await this.domains.isVerified(emailDomain(email)))) {
        throw new SsoRefused('domain_unverified');
      }
      // SAML has no such claim: the verified domain above is its trust. An
      // OAuth 2.0 connection says by its mapping (`emailVerified`), whose
      // `verified-domains` mode is that same trust.
      if (connection.protocol !== 'saml' && !identity.emailVerified) {
        throw new SsoRefused('email_unverified');
      }
      const existing = await this.users.findByEmail(email, tx);
      let userId: string;
      if (existing) {
        if (!existing.active) {
          throw new SsoRefused('account_inactive');
        }
        // Whoever registered an address without proving it must not get its
        // owner's sign-ins (account pre-hijacking): they prove it first.
        if (!existing.emailVerified) {
          throw new SsoRefused('account_unverified');
        }
        userId = existing.id;
      } else {
        if (!connection.jitProvisioning) {
          throw new SsoRefused('not_a_member');
        }
        const created = await this.users.create(tx, {
          email,
          name: identity.name?.trim() || email,
          passwordHash: null,
          emailVerified: true,
        });
        userId = created.id;
        await this.audit.record(
          created,
          {
            action: 'user.signed-up',
            targetType: 'user',
            targetId: userId,
            details: { via: 'sso', connectionId: connection.id },
          },
          tx,
        );
      }
      const provisioned = await this.ensureMember(
        tx,
        connection,
        userId,
        identity,
      );
      await tx.insert(userIdentities).values({
        provider,
        subject: identity.subject,
        userId,
        email,
      });
      await this.audit.record(
        null,
        {
          action: 'user.identity-linked',
          targetType: 'user',
          targetId: userId,
          details: { provider, connectionId: connection.id, tenantId },
        },
        tx,
      );
      return {
        userId,
        rolesChanged: await this.syncRoles(
          tx,
          connection,
          userId,
          identity,
          provisioned,
        ),
      };
    });
  }

  /**
   * The roles the connection gives (docs/auth.md, "Roles from the IdP"), in
   * the sign-in's transaction; whether any grant changed.
   *
   * - A member it just provisioned gets its default roles (`group` null),
   *   once: theirs to keep, as an invitation's.
   * - With group mappings, at every sign-in: the roles of the groups the IdP
   *   lists are granted (marked in `sso_role_grants`), and those a mapping of
   *   this connection granted whose group it no longer lists are taken back.
   *   A role the member holds otherwise (an administrator's grant) is left
   *   alone, given or not. Without group mappings nothing is touched.
   * - Taking back the tenant's last administrator role is skipped (a
   *   savepoint, audited): the IdP can't lock the tenant out.
   *
   * No grant check here: the administrator who set the mappings had to be
   * able to grant each role (SsoConnectionsService).
   */
  private async syncRoles(
    tx: Transaction,
    connection: SsoConnection,
    userId: string,
    identity: SsoIdentity,
    provisioned: boolean,
  ) {
    const mappings = await tx
      .select({ group: ssoRoleMappings.group, roleId: ssoRoleMappings.roleId })
      .from(ssoRoleMappings)
      .where(eq(ssoRoleMappings.connectionId, connection.id));
    if (mappings.length === 0) {
      return false;
    }
    const now = new Date();
    // A grant that ended counts as none (a later grant replaces it).
    await tx
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.tenantId, connection.tenantId),
          eq(userRoles.userId, userId),
          lte(userRoles.expiresAt, now),
        ),
      );
    const held = new Set(
      (
        await tx
          .select({ roleId: userRoles.roleId })
          .from(userRoles)
          .where(
            and(
              eq(userRoles.tenantId, connection.tenantId),
              eq(userRoles.userId, userId),
            ),
          )
      ).map((row) => row.roleId),
    );
    const added: string[] = [];
    if (provisioned) {
      const defaults = mappings
        .filter((mapping) => mapping.group === null)
        .map((mapping) => mapping.roleId)
        .filter((roleId) => !held.has(roleId));
      if (defaults.length > 0) {
        await tx
          .insert(userRoles)
          .values(defaults.map((roleId) => ({ userId, roleId })))
          .onConflictDoNothing();
        defaults.forEach((roleId) => held.add(roleId));
        added.push(...defaults);
      }
    }
    const grouped = mappings.filter((mapping) => mapping.group !== null);
    let removed: string[] = [];
    let kept: string[] = [];
    if (grouped.length > 0) {
      const listed = new Set(identity.groups ?? []);
      const wanted = new Set(
        grouped
          .filter((mapping) => listed.has(mapping.group!))
          .map((mapping) => mapping.roleId),
      );
      const granting = [...wanted].filter((roleId) => !held.has(roleId));
      if (granting.length > 0) {
        await tx
          .insert(userRoles)
          .values(granting.map((roleId) => ({ userId, roleId })))
          .onConflictDoNothing();
        await tx
          .insert(ssoRoleGrants)
          .values(
            granting.map((roleId) => ({
              userId,
              roleId,
              connectionId: connection.id,
            })),
          )
          .onConflictDoNothing();
        added.push(...granting);
      }
      const ours = await tx
        .select({ roleId: ssoRoleGrants.roleId })
        .from(ssoRoleGrants)
        .where(
          and(
            eq(ssoRoleGrants.userId, userId),
            eq(ssoRoleGrants.connectionId, connection.id),
          ),
        );
      const taking = ours
        .map((row) => row.roleId)
        .filter((roleId) => !wanted.has(roleId));
      if (taking.length > 0) {
        try {
          // A savepoint: refused, the grants stay and the sign-in goes on.
          await tx.transaction(async (savepoint) => {
            await savepoint
              .delete(userRoles)
              .where(
                and(
                  eq(userRoles.userId, userId),
                  inArray(userRoles.roleId, taking),
                ),
              );
            await this.accessAdmin.assertAnAdministratorRemains(savepoint);
          });
          removed = taking;
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          kept = taking;
        }
      }
    }
    if (added.length === 0 && removed.length === 0 && kept.length === 0) {
      return false;
    }
    await this.audit.record(
      null,
      {
        action: 'sso.roles-synced',
        targetType: 'user',
        targetId: userId,
        details: {
          connectionId: connection.id,
          added,
          removed,
          // Not taken back: the tenant's last administrator.
          ...(kept.length > 0 && { keptLastAdministrator: kept }),
        },
      },
      tx,
    );
    return added.length > 0 || removed.length > 0;
  }

  /**
   * The user is an active member of the connection's tenant: already, or
   * now (just-in-time, for an address of a verified domain; true). A
   * deactivated membership (deprovisioned) is refused, never brought back
   * by a sign-in.
   */
  private async ensureMember(
    tx: Transaction,
    connection: SsoConnection,
    userId: string,
    identity: SsoIdentity,
  ) {
    await this.users.lockMembership(tx, connection.tenantId, userId);
    const [membership] = await tx
      .select({ active: memberships.active })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, connection.tenantId),
          eq(memberships.userId, userId),
        ),
      );
    if (membership) {
      if (!membership.active) {
        throw new SsoRefused('membership_inactive');
      }
      return false;
    }
    if (!connection.jitProvisioning) {
      throw new SsoRefused('not_a_member');
    }
    // A known identity whose membership went (an administrator removed it)
    // comes back only as a new person would: an address of a verified domain.
    const account = await this.users.findView(userId, tx);
    if (
      !account ||
      !(await this.domains.isVerified(emailDomain(account.email)))
    ) {
      throw new SsoRefused('domain_unverified');
    }
    if (!(await this.users.lockAccount(tx, userId))) {
      throw new SsoRefused('account_inactive');
    }
    await this.users.addMembership(tx, connection.tenantId, userId);
    await this.audit.record(
      account,
      {
        action: 'member.provisioned',
        targetType: 'user',
        targetId: userId,
        details: {
          via: 'sso',
          connectionId: connection.id,
          subject: identity.subject,
        },
      },
      tx,
    );
    this.logger.log('Member provisioned just in time', {
      userId,
      connectionId: connection.id,
    });
    return true;
  }

  /**
   * Signs the browser in (the package's SignInService: the session cookie,
   * the previous session ended), in the connection's tenant, as `sso` by
   * this connection, at the IdP's authentication time when it told one.
   */
  async signIn(
    connection: SsoConnection,
    userId: string,
    context: { ip: string; userAgent: unknown; authenticatedAt?: Date | null },
  ) {
    const method = ssoProvider(connection.id);
    await this.signInService.signIn(userId, {
      method,
      metadata: {
        ...methodMetadata(method),
        tenantId: connection.tenantId,
        ...(context.authenticatedAt && {
          authenticatedAt: context.authenticatedAt.toISOString(),
        }),
      },
    });
    const user = await this.users.findActive(userId);
    if (user) {
      await this.securityAlerts.signedIn(user, {
        ip: context.ip,
        userAgent: context.userAgent,
        method,
        tenantId: connection.tenantId,
        details: { connectionId: connection.id, protocol: connection.protocol },
      });
    }
  }

  /** A refused sign-in, in the tenant's audit log: who (as the IdP named them) and why. */
  async refused(
    connection: SsoConnection,
    label: string,
    reason: string,
    ip: string,
  ) {
    await this.audit.recordAnonymous(label.slice(0, 320), {
      action: 'auth.sign-in-failed',
      targetType: 'sso-connection',
      targetId: connection.id,
      details: {
        method: ssoProvider(connection.id),
        protocol: connection.protocol,
        reason,
      },
      ip,
    });
  }
}
