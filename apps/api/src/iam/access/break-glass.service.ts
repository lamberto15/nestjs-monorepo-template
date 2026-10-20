import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenantScope } from '../../core/tenancy/tenant-scope.js';
import { normalizeIp } from '../account/devices.js';
import { AuditService } from '../audit/audit.service.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { AUTH_POLICY, type AuthPolicySource } from '../auth/auth-policy.js';
import { actsAsOperator } from '../auth/operator-only.js';
import { principalKey, type UserPrincipal } from '../auth/principal.js';
import { IAM_NOTIFIER, type IamNotifier } from '../iam-notifications.js';
import {
  breakGlassGrants,
  memberships,
  roles,
  userRoles,
} from '../iam.tables.js';
import { AccessService } from './access.service.js';

/** The longest a grant lasts, and its default: an hour. */
export const BREAK_GLASS_MAX_MINUTES = 60;

/** The request header that names the grant a request reads through. */
export const BREAK_GLASS_HEADER = 'break-glass';

/** What a grant's routes answer. */
export interface BreakGlassGrantView {
  id: string;
  tenantId: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
}

const refused = (code: string, message: string) =>
  new ForbiddenException({ code, message });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Break-glass (docs/tenancy.md, "Break-glass"): an operator reads a
 * tenant that never invited them, in an emergency. Custom: no package
 * offers cross-tenant emergency access; it is built from the app's own
 * parts (the tenant scope, the audit log, the notifications).
 *
 * - **Who**: a member of the operator tenant holding `Platform.breakGlass`
 *   (checked when the grant opens and on every request through it).
 * - **What**: read only. The request's transactions are `READ ONLY`
 *   (`readOnlyTenantScope()`: PostgreSQL refuses any write) and its
 *   ability is the catalog's read actions; a non-GET request is refused
 *   before it runs (403 `break_glass_read_only`).
 * - **How long**: at most an hour, never extended; another grant needs a
 *   new reason, and only once this one ended.
 * - **Told**: the reason is kept with the grant and in both tenants'
 *   audit entries (`tenant.break-glass-started`, `…-ended`); the tenant's
 *   administrators get `security.breakGlassStarted` at once (mandatory, in
 *   the app and by mail) and see it in their sign-in log (`method:
 *   break-glass`).
 * - **Opt-out**: the tenant's setting `auth.allowBreakGlass: false`
 *   refuses new grants and stops running ones.
 */
@Injectable()
export class BreakGlassService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    @Optional()
    @Inject(IAM_NOTIFIER)
    private readonly notifier?: IamNotifier,
    @Optional()
    @Inject(AUTH_POLICY)
    private readonly policy?: AuthPolicySource,
  ) {}

  /**
   * Opens `targetId` to `operator` for `minutes` (at most an hour), for
   * `reason`. The tenant's side first, in one transaction of its own: its
   * audit entry, its sign-in log's entry and its administrators'
   * notifications; then the grant and the operators' entry. A failure in
   * between leaves the tenant told of a grant that never opened, never
   * the reverse.
   */
  async start(
    operator: UserPrincipal,
    targetId: string,
    input: { reason: string; minutes?: number },
    ip?: string,
  ): Promise<BreakGlassGrantView> {
    const operatorTenantId = operator.tenantId;
    if (!operatorTenantId || operator.impersonator || operator.breakGlass) {
      throw refused(
        'break_glass_not_allowed',
        'Open a break-glass grant from your own session in the operator tenant.',
      );
    }
    const target = await this.tenancy.find(targetId);
    if (!target) {
      throw new NotFoundException(`Tenant ${targetId} not found.`);
    }
    if (target.operator || target.id === operatorTenantId) {
      throw new ConflictException({
        code: 'break_glass_own_tenant',
        message: 'Break-glass opens another tenant, not the operators’ own.',
      });
    }
    if (!target.active) {
      throw new ConflictException({
        code: 'tenant_inactive',
        message: 'This tenant is deactivated: nobody acts in it.',
      });
    }
    if (!(await this.allowed(target.id))) {
      throw refused(
        'break_glass_disabled',
        'This tenant opted out of break-glass access (auth.allowBreakGlass).',
      );
    }
    const now = new Date();
    const [running] = await database(this.txHost)
      .select({ id: breakGlassGrants.id })
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.userId, operator.id),
          eq(breakGlassGrants.targetTenantId, target.id),
          isNull(breakGlassGrants.endedAt),
          gt(breakGlassGrants.expiresAt, now),
        ),
      )
      .limit(1);
    if (running) {
      throw new ConflictException({
        code: 'break_glass_active',
        message:
          'You hold a break-glass grant to this tenant: it is never extended. End it first; a new one needs a new reason.',
      });
    }
    const id = randomUUID();
    const minutes = Math.min(
      input.minutes ?? BREAK_GLASS_MAX_MINUTES,
      BREAK_GLASS_MAX_MINUTES,
    );
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const address = ip ? normalizeIp(ip) : undefined;
    const details = {
      grantId: id,
      reason: input.reason,
      expiresAt: expiresAt.toISOString(),
      operatorTenantId,
      tenant: target.slug,
    };

    // The tenant's side: its log, its sign-in log, its administrators told.
    const told = await this.tenancy.run(tenantScope(target.id), () =>
      inTransaction(this.txHost, async (tx) => {
        await this.audit.record(
          operator,
          {
            action: 'tenant.break-glass-started',
            targetType: 'tenant',
            targetId: target.id,
            details,
            ip: address,
          },
          tx,
        );
        await this.audit.record(
          operator,
          {
            action: SIGN_IN_ACTIONS.succeeded,
            targetType: 'user',
            targetId: operator.id,
            details: { method: 'break-glass', grantId: id },
            ip: address,
          },
          tx,
        );
        if (!this.notifier) {
          return [];
        }
        const administrators = await this.administrators(target.id);
        for (const userId of administrators) {
          await this.notifier.notify(tx, {
            type: 'security.breakGlassStarted',
            to: principalKey({ kind: 'user', id: userId }),
            key: `break-glass:${id}`,
            data: {
              operator: operator.email,
              reason: input.reason,
              expiresAt: expiresAt.toISOString(),
              ip: address ?? '',
            },
            link: '/audit',
          });
        }
        return administrators;
      }),
    );

    // The operators' side: the grant, and their own log.
    const [grant] = await inTransaction(this.txHost, async (tx) => {
      const rows = await tx
        .insert(breakGlassGrants)
        .values({
          id,
          userId: operator.id,
          targetTenantId: target.id,
          reason: input.reason,
          expiresAt,
        })
        .returning();
      await this.audit.record(
        operator,
        {
          action: 'tenant.break-glass-started',
          targetType: 'tenant',
          targetId: target.id,
          details,
          ip: address,
        },
        tx,
      );
      return rows;
    });

    if (this.notifier && told.length) {
      this.notifier.deliverNow();
      await Promise.all(
        told.map((userId) =>
          this.notifier!.announceUnread({ kind: 'user', id: userId }),
        ),
      );
    }
    return view(grant!);
  }

  /** The operator's grants to `targetId`, newest first (theirs only). */
  async list(operator: UserPrincipal, targetId: string) {
    const rows = await database(this.txHost)
      .select()
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.userId, operator.id),
          eq(breakGlassGrants.targetTenantId, targetId),
        ),
      )
      .orderBy(desc(breakGlassGrants.createdAt))
      .limit(50);
    return rows.map(view);
  }

  /**
   * Ends the operator's grant before its time (404 when it isn't theirs,
   * or for another tenant). Ending an ended or expired one changes
   * nothing. Audited `tenant.break-glass-ended` in both tenants.
   */
  async end(
    operator: UserPrincipal,
    targetId: string,
    grantId: string,
    ip?: string,
  ) {
    const now = new Date();
    const outcome = await inTransaction(this.txHost, async (tx) => {
      const [grant] = await tx
        .select()
        .from(breakGlassGrants)
        .where(
          and(
            eq(breakGlassGrants.id, grantId),
            eq(breakGlassGrants.userId, operator.id),
            eq(breakGlassGrants.targetTenantId, targetId),
          ),
        )
        .for('update');
      if (!grant) {
        throw new NotFoundException(`Break-glass grant ${grantId} not found.`);
      }
      if (grant.endedAt || grant.expiresAt <= now) {
        return { grant, ended: false };
      }
      const [updated] = await tx
        .update(breakGlassGrants)
        .set({ endedAt: now })
        .where(eq(breakGlassGrants.id, grantId))
        .returning();
      await this.audit.record(operator, endedEntry(updated!, ip), tx);
      return { grant: updated!, ended: true };
    });
    if (outcome.ended) {
      await this.tenancy.run(tenantScope(targetId), () =>
        this.audit.record(operator, endedEntry(outcome.grant, ip)),
      );
    }
    return view(outcome.grant);
  }

  /**
   * The tenant a request through grant `grantId` reads (BreakGlassGuard),
   * checked again on every request, in the operator's own scope: an
   * operator still (an active member of the active operator tenant), still
   * holding `Platform.breakGlass`, their grant neither ended nor expired,
   * the tenant active and not opted out. 403 otherwise.
   */
  async resolve(
    user: UserPrincipal,
    grantId: string,
  ): Promise<{ tenantId: string; expiresAt: Date }> {
    if (user.impersonator || !user.tenantId || !UUID.test(grantId)) {
      throw invalid();
    }
    if (
      !(await actsAsOperator(this.tenancy, user)) ||
      !(await this.access.can(user, 'breakGlass', 'Platform'))
    ) {
      throw invalid();
    }
    const [grant] = await database(this.txHost)
      .select()
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.id, grantId),
          eq(breakGlassGrants.userId, user.id),
        ),
      );
    if (!grant || grant.endedAt) {
      throw invalid();
    }
    if (grant.expiresAt.getTime() <= Date.now()) {
      throw refused(
        'break_glass_expired',
        'This break-glass grant has expired: it is never extended. Open a new one, with a new reason.',
      );
    }
    const target = await this.tenancy.find(grant.targetTenantId);
    if (!target?.active) {
      throw invalid();
    }
    if (!(await this.allowed(target.id))) {
      throw refused(
        'break_glass_disabled',
        'This tenant opted out of break-glass access (auth.allowBreakGlass).',
      );
    }
    return { tenantId: target.id, expiresAt: grant.expiresAt };
  }

  private allowed(tenantId: string) {
    return this.policy?.allowsBreakGlass
      ? this.policy.allowsBreakGlass(tenantId)
      : Promise.resolve(true);
  }

  /**
   * The tenant's administrators, in its scope: active members holding its
   * built-in Administrator role (`roles.system`) unexpired.
   */
  private async administrators(tenantId: string) {
    const now = new Date();
    const rows = await database(this.txHost)
      .selectDistinct({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, userRoles.userId),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(roles.system, true),
          eq(memberships.active, true),
          or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, now)),
        ),
      );
    return rows.map((row) => row.userId);
  }
}

const invalid = () =>
  refused(
    'break_glass_invalid',
    'No break-glass grant of yours by this id is open: it ended, expired, or you may no longer use it.',
  );

const endedEntry = (
  grant: typeof breakGlassGrants.$inferSelect,
  ip?: string,
) => ({
  action: 'tenant.break-glass-ended',
  targetType: 'tenant',
  targetId: grant.targetTenantId,
  details: { grantId: grant.id, reason: grant.reason },
  ip: ip ? normalizeIp(ip) : undefined,
});

const view = (
  grant: typeof breakGlassGrants.$inferSelect,
): BreakGlassGrantView => ({
  id: grant.id,
  tenantId: grant.targetTenantId,
  reason: grant.reason,
  createdAt: grant.createdAt.toISOString(),
  expiresAt: grant.expiresAt.toISOString(),
  endedAt: grant.endedAt?.toISOString() ?? null,
});
