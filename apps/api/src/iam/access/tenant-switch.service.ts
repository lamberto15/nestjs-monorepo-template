import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type SessionRecord,
  SessionService,
  TokenService,
} from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { createHash, randomUUID } from 'node:crypto';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenantScope } from '../../core/tenancy/tenant-scope.js';
import { notWhileImpersonating } from '../account/account.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { DrizzleAuthenticationStore } from '../auth/drizzle-authentication.store.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SessionLifecycleRegistry } from '../auth/session-lifecycle.registry.js';
import { UsersRepository } from '../auth/users.repository.js';

/**
 * Moving a session to another of the user's tenants (docs/tenancy.md): one
 * origin, the session carries its tenant, and a switch re-issues it.
 */
@Injectable()
export class TenantSwitchService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly accounts: UsersRepository,
    private readonly sessions: SessionService,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly store: DrizzleAuthenticationStore,
    private readonly sessionLifecycle: SessionLifecycleRegistry,
  ) {}

  /**
   * The user's tenants (active memberships of active tenants, the last
   * chosen first), `current` the one they act in. While impersonating,
   * only that one: the person's other tenants are theirs, not the
   * administrator's to see.
   */
  async tenantsOf(user: UserPrincipal) {
    const rows = await this.accounts.memberships(user.id);
    return rows
      .filter((row) => !user.impersonator || row.id === user.tenantId)
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        operator: row.operator,
        current: row.id === user.tenantId,
      }));
  }

  /**
   * Re-issues `session` in `tenantId`, one of the user's active tenants
   * (404 otherwise, never while impersonating). The choice (the next
   * sign-in starts there) and its audit entry, in the tenant entered, are
   * one transaction, done first: a failure there leaves the session as it
   * was. Then the rotation, which a concurrent sign-out may have made
   * impossible (null: the caller answers 401).
   */
  async switch(
    user: UserPrincipal,
    session: SessionRecord,
    tenantId: string,
    ip?: string,
  ) {
    notWhileImpersonating(user);
    if (!(await this.accounts.isMember(user.id, tenantId))) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'You are not a member of this tenant.',
      });
    }
    await this.choose(user, tenantId, ip);
    // A new session id for the new tenant, as for any change of privilege.
    // Without `authenticatedAt`: a step-up proven in one tenant doesn't
    // authorize sensitive actions in another (#738); the new tenant asks
    // again. The sign-in method and its factors stay.
    const { authenticatedAt: _stepUp, ...metadata } = (session.metadata ??
      {}) as Record<string, unknown>;
    return this.sessions.rotate(session, {
      metadata: { ...metadata, tenantId },
    });
  }

  /**
   * A token client's switch (POST /auth/token/refresh with `tenantId`):
   * the refresh, whose pair acts in `tenantId` (`tid`), and the family with
   * it from then on. Not a member (or the account gone): the token
   * sign-in's 401, the refresh token unspent. Then as `switch()`: the choice
   * and its audit entry first, a new `sid` (the session's new id) and no
   * `auth_time` (the step-up, asked again in the new tenant; the method
   * and factors, `amr`, stay); the old `sid`'s sockets reconnect. A token
   * unknown or spent goes to the plain refresh, which refuses it (and
   * revokes the family it was stolen from).
   */
  async switchTokens(refreshToken: string, tenantId: string, ip?: string) {
    const record = await this.store.getRefreshToken(
      createHash('sha256').update(refreshToken).digest('base64url'),
    );
    if (!record || record.usedAt) {
      return this.tokens.refresh(refreshToken);
    }
    const user = await this.accounts.inTenant(record.userId, tenantId);
    if (!user) {
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    const from = record.claims?.tid;
    await this.choose(
      { ...user, tenantId: typeof from === 'string' ? from : null },
      tenantId,
      ip,
    );
    const oldSid = record.claims?.sid;
    const pair = await this.tokens.refresh(refreshToken, {
      claims: ({ auth_time: _stepUp, ...claims }) => ({
        ...claims,
        tid: tenantId,
        sid: randomUUID(),
      }),
    });
    if (typeof oldSid === 'string') {
      // Not revoked (its access tokens live until they expire): its
      // sockets, in the old tenant's rooms, end and reconnect.
      await this.sessionLifecycle.afterTokenRevocation(oldSid);
    }
    return pair;
  }

  /** The next sign-in starts in `tenantId`, audited there (`from`: the user's tenant). */
  private async choose(user: UserPrincipal, tenantId: string, ip?: string) {
    await this.tenancy.run(tenantScope(tenantId), () =>
      inTransaction(this.txHost, async (tx) => {
        await this.accounts.selectTenant(user.id, tenantId, tx);
        await this.audit.record(
          { ...user, tenantId },
          {
            action: 'auth.tenant-switched',
            targetType: 'tenant',
            targetId: tenantId,
            details: { from: user.tenantId },
            ip,
          },
          tx,
        );
      }),
    );
  }
}
