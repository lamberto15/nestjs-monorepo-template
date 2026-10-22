import { Injectable, NotFoundException } from '@nestjs/common';
import { type SessionRecord, SessionService } from '@nestjs/authentication';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenantScope } from '../../core/tenancy/tenant-scope.js';
import { notWhileImpersonating } from '../account/account.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
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
    // A new session id for the new tenant, as for any change of privilege.
    return this.sessions.rotate(session, {
      metadata: { ...session.metadata, tenantId },
    });
  }
}
