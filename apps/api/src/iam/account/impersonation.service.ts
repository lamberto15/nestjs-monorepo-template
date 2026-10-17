import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { type SessionRecord, SessionService } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { splitAuthentication } from '../auth/authentication-method.js';
import { type Impersonation, impersonationOf } from '../auth/impersonation.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { AccessAdminService } from '../access/access-admin.service.js';
import { roles, userRoles } from '../iam.tables.js';

/**
 * Acting as another user, for support: the administrator's session is
 * replaced by one of the user's, which records who is behind it. Every audit
 * entry made meanwhile reads `admin@… as user@…`; `GET /auth/me` shows it;
 * the session ends after IMPERSONATION_TTL_MINUTES. Stopping gives the
 * administrator their own session back.
 *
 * Never as an administrator (no way up), never as oneself, never nested; and
 * while impersonating, the account's credentials can't be changed (password,
 * email, two-factor, sessions) and no new impersonation can start.
 */
@Injectable()
export class ImpersonationService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly sessions: SessionService,
    private readonly accounts: UsersRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly admin: AccessAdminService,
  ) {}

  /** Starts acting as `targetId`: returns the new session's Set-Cookie value. */
  async start(
    actor: UserPrincipal,
    session: SessionRecord,
    targetId: string,
    ip?: string,
  ) {
    if (actor.impersonator || impersonationOf(session)) {
      throw new ConflictException('Stop the current impersonation first.');
    }
    if (targetId === actor.id) {
      throw new ConflictException('You can’t impersonate yourself.');
    }
    // Never across tenants (docs/tenancy.md): the target is an active
    // member of the tenant the administrator acts in, and the impersonation
    // stays in it (no switching; SessionAuth ends it if either leaves).
    const tenantId = actor.tenantId;
    const target = tenantId
      ? await this.accounts.inTenant(targetId, tenantId)
      : null;
    if (!target || !tenantId || target.tenantId !== tenantId) {
      throw new NotFoundException(`User ${targetId} not found.`);
    }
    if (await this.isAdministrator(targetId)) {
      throw new ForbiddenException('Administrators can’t be impersonated.');
    }
    // Never more than the actor holds: acting as someone gives no rights you couldn't grant.
    await this.admin.assertAuthorityOver(
      actor,
      await this.admin.permissionsOfHolder('user', targetId),
      target.email,
    );
    const now = new Date();
    const minutes = this.config.get('IMPERSONATION_TTL_MINUTES', {
      infer: true,
    });
    const { rest, authentication } = splitAuthentication(session.metadata);
    const impersonator: Impersonation = {
      id: actor.id,
      email: actor.email,
      mfa: session.mfa ?? null,
      authentication,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      tenantId,
    };
    await this.sessions.revoke(session.id, { userId: actor.id });
    const issued = await this.sessions.create(target.id, {
      // The administrator's second factor stands for this session; their
      // sign-in's time doesn't (no authenticatedAt: never a recent one).
      mfa: session.mfa,
      metadata: { ...rest, method: 'impersonation', impersonator, tenantId },
    });
    await this.audit.record(actor, {
      action: 'user.impersonation-started',
      targetType: 'user',
      targetId: target.id,
      details: { email: target.email, endsAt: impersonator.endsAt },
      ip,
    });
    return { cookie: issued.cookie, user: target, endsAt: impersonator.endsAt };
  }

  /** Ends the impersonation: returns the administrator's new session's Set-Cookie value. */
  async stop(user: UserPrincipal, session: SessionRecord, ip?: string) {
    const impersonation = impersonationOf(session);
    if (!impersonation) {
      throw new ConflictException('You are not impersonating anyone.');
    }
    await this.sessions.revoke(session.id, { userId: session.userId });
    const { impersonator: _, ...metadata } = splitAuthentication(
      session.metadata,
    ).rest;
    const issued = await this.sessions.create(impersonation.id, {
      mfa: impersonation.mfa ?? undefined,
      // Back in the tenant it was started in.
      metadata: {
        ...metadata,
        ...impersonation.authentication,
        tenantId: impersonation.tenantId,
      },
    });
    await this.audit.record(
      {
        kind: 'user',
        id: impersonation.id,
        email: impersonation.email,
        name: impersonation.email,
        emailVerified: true,
        locale: null,
        timezone: null,
        tenantId: impersonation.tenantId,
      },
      {
        action: 'user.impersonation-stopped',
        targetType: 'user',
        targetId: user.id,
        details: { email: user.email },
        ip,
      },
    );
    return { cookie: issued.cookie };
  }

  private async isAdministrator(userId: string) {
    const [row] = await this.db
      .select({ roleId: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(roles.system, true),
          or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, new Date())),
        ),
      )
      .limit(1);
    return !!row;
  }
}
