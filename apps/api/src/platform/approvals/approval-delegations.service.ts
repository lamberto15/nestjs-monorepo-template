import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { users } from '../../iam/iam.tables.js';
import { SettingsService } from '../settings/settings.service.js';
import { APPROVAL_MAX_DELEGATION_DAYS } from './approval-settings.js';
import type { CreateDelegationDto } from './approval.schemas.js';
import {
  approvalDelegations,
  type ApprovalDelegationRow,
} from './approvals.tables.js';

/**
 * Out of office: a user lets another decide their approvals for a period
 * (all subjects, or one). The delegate decides on the approver's
 * assignment, recorded as theirs `onBehalfOf` the approver; the approver
 * may still decide themselves. Users only.
 */
@Injectable()
export class ApprovalDelegationsService {
  /** The newest this many a list shows (a person gives and holds a handful). */
  private static readonly LISTED = 200;

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly i18n: I18nService,
    private readonly settings: SettingsService,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  /** The caller's delegations, given and received, newest first. */
  async list(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(
        or(
          eq(approvalDelegations.fromUserId, user.id),
          eq(approvalDelegations.toUserId, user.id),
        ),
      )
      .orderBy(desc(approvalDelegations.id))
      .limit(ApprovalDelegationsService.LISTED);
    return { items: await this.views(rows) };
  }

  /** Not while acting as someone else: an administrator could hand themselves that person's approvals. */
  private assertNotImpersonating(user: UserPrincipal) {
    if (user.impersonator) {
      throw new ForbiddenException({
        code: 'approval_impersonation',
        message: this.i18n.translate('auth.notWhileImpersonating'),
      });
    }
  }

  async create(user: UserPrincipal, dto: CreateDelegationDto, ip?: string) {
    this.assertNotImpersonating(user);
    const days = await this.settings.get(APPROVAL_MAX_DELEGATION_DAYS);
    if (
      new Date(dto.endsAt).getTime() - new Date(dto.startsAt).getTime() >
      days * 86_400_000
    ) {
      const message = this.i18n.translate('approvals.delegationTooLong', {
        args: { days },
      });
      throw new BadRequestException({
        code: 'validation_failed',
        message,
        errors: [{ path: 'endsAt', message }],
      });
    }
    if (dto.toUserId === user.id) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: this.i18n.translate('approvals.delegateToSelf'),
        errors: [
          {
            path: 'toUserId',
            message: this.i18n.translate('approvals.delegateToSelf'),
          },
        ],
      });
    }
    const [delegate] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, dto.toUserId), eq(users.active, true)));
    if (!delegate) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: this.i18n.translate('approvals.unknownUser'),
        errors: [
          {
            path: 'toUserId',
            message: this.i18n.translate('approvals.unknownUser'),
          },
        ],
      });
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(approvalDelegations)
        .values({
          fromUserId: user.id,
          toUserId: dto.toUserId,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          subject: dto.subject ?? null,
        })
        .returning();
      await this.audit.record(
        user,
        {
          action: 'approvalDelegation.created',
          targetType: 'ApprovalDelegation',
          targetId: created!.id,
          details: {
            toUserId: dto.toUserId,
            startsAt: dto.startsAt,
            endsAt: dto.endsAt,
            subject: dto.subject ?? null,
          },
          ip,
        },
        tx,
      );
      return created!;
    });
    return (await this.views([row]))[0]!;
  }

  /** Ends one of the caller's own delegations (given, not received). */
  async remove(user: UserPrincipal, id: string, ip?: string) {
    this.assertNotImpersonating(user);
    await inTransaction(this.txHost, async (tx) => {
      const [removed] = await tx
        .delete(approvalDelegations)
        .where(
          and(
            eq(approvalDelegations.id, id),
            eq(approvalDelegations.fromUserId, user.id),
          ),
        )
        .returning();
      if (!removed) {
        throw new NotFoundException();
      }
      await this.audit.record(
        user,
        {
          action: 'approvalDelegation.removed',
          targetType: 'ApprovalDelegation',
          targetId: id,
          details: { toUserId: removed.toUserId },
          ip,
        },
        tx,
      );
    });
  }

  private async views(rows: ApprovalDelegationRow[]) {
    const ids = [
      ...new Set(rows.flatMap((row) => [row.fromUserId, row.toUserId])),
    ];
    const names = new Map(
      ids.length
        ? (
            await this.db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, ids))
          ).map((row) => [row.id, row.name])
        : [],
    );
    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      fromUserId: row.fromUserId,
      fromName: names.get(row.fromUserId) ?? '',
      toUserId: row.toUserId,
      toName: names.get(row.toUserId) ?? '',
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      subject: row.subject,
      active: row.startsAt.getTime() <= now && row.endsAt.getTime() > now,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
