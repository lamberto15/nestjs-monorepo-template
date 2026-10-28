import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { validationException } from '../../core/http/problem-details.filter.js';
import { MailQueue } from '../../core/mail/mail-queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import {
  normalizeEmail,
  UsersRepository,
} from '../../iam/auth/users.repository.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import {
  type CreateShareDto,
  MAX_SHARES_PER_RECORD,
  type OpenShareDto,
  SHARE_CODE_ATTEMPTS,
  SHARE_CODE_MINUTES,
  SHARE_MAX_DAYS,
  type ShareView,
} from './share.schemas.js';
import { ShareCodeMail } from './share.mails.js';
import { SharesRegistry, type ShareTarget } from './shares.registry.js';
import { recordShares } from './shares.tables.js';

type Row = typeof recordShares.$inferSelect;

/** `shr_<tenant id>_<secret>`: the tenant, so the link is read in its scope. */
const TOKEN =
  /^shr_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

const hashOf = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

/** The code's hash, bound to its link: a code of one link opens no other. */
const codeHashOf = (shareId: string, code: string) =>
  hashOf(`${shareId}:${code}`);

/** Every refusal of a link: forged, expired, revoked, its record or maker gone. One answer, no oracle. */
const notFound = () =>
  new NotFoundException({
    code: 'share_not_found',
    message: t('auth.invalidLink'),
  });

/**
 * Read-only links to one record (docs/sharing.md): a member who may share
 * a record (its subject's `share` action) makes a link that shows chosen
 * fields of it (and its files, or not) to whoever holds the link, or only
 * to one address that proves its mailbox with a mailed code, until it
 * expires or is revoked.
 *
 * The link's token (`shr_<tenant>_<secret>`, 256 random bits) is shown
 * once; only its hash is kept. Opening it checks, every time: the link
 * (not revoked, not expired), its tenant (active), its maker (still an
 * active member) and the record (there, not in the recycle bin, and still
 * readable and shareable by the maker), and shows the shared fields as the
 * maker may read them now: a link never shows more than its maker sees,
 * never another record (no reference field is shared, nothing is
 * expanded), and is no sign-in: its holder is nobody in the tenant.
 * Making, revoking and every opening are audited (`share.created`,
 * `share.revoked`, `share.opened`); the token is never logged nor audited.
 */
@Injectable()
export class SharesService {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: SharesRegistry,
    private readonly tenancy: Tenancy,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly mailQueue: MailQueue,
    private readonly config: ConfigService<CoreEnv, true>,
    purges: RecordPurgeRegistry,
  ) {
    // A record purged from its recycle bin takes its links with it.
    purges.register({
      name: 'shares',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /** A record's links, newest first (revoked and expired ones too): for who may share it. */
  async list(principal: RequestPrincipal, record: RecordRef) {
    await this.target(record.subject).assertCanShare(
      principal,
      record.recordId,
    );
    const rows = await this.db
      .select()
      .from(recordShares)
      .where(this.ofRecord(record))
      .orderBy(desc(recordShares.id));
    return { items: rows.map((row) => this.view(row)) };
  }

  /** A new link to the record: its token is in this answer only. */
  async create(
    principal: RequestPrincipal,
    record: RecordRef,
    dto: CreateShareDto,
    ip?: string,
  ) {
    if (principal.kind !== 'user') {
      // An API client is nobody to answer for a link a person opens.
      throw new ForbiddenException('Only a person shares a record by link.');
    }
    // An impersonating administrator would hand out what the user sees.
    notWhileImpersonating(principal);
    const target = this.target(record.subject);
    await target.assertCanShare(principal, record.recordId);
    const fields = [...new Set(dto.fields)];
    const unknown = fields.filter((name) => !target.fields.includes(name));
    if (unknown.length) {
      throw validationException([
        {
          path: ['fields'],
          message: `Not fields a link shares: ${unknown.join(', ')}. Any of ${target.fields.join(', ')}.`,
        },
      ]);
    }
    const shown = await target.shared(principal, record.recordId, fields);
    const hidden = fields.filter((name) => !shown || !(name in shown));
    if (hidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not read: ${hidden.join(', ')}.`,
        fields: hidden,
      });
    }
    if (dto.files && !target.files) {
      throw validationException([
        {
          path: ['files'],
          message: `${record.subject} records take no files.`,
        },
      ]);
    }
    const expiresAt = new Date(dto.expiresAt);
    const now = Date.now();
    if (
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > now + SHARE_MAX_DAYS * 86_400_000
    ) {
      throw validationException([
        {
          path: ['expiresAt'],
          message: `In the future, within ${SHARE_MAX_DAYS} days.`,
        },
      ]);
    }
    const tenantId = this.tenancy.tenantId('A share');
    const token = `shr_${tenantId}_${randomBytes(32).toString('base64url')}`;
    const row = await inTransaction(this.txHost, async (tx) => {
      const [{ open }] = await tx
        .select({ open: count() })
        .from(recordShares)
        .where(and(this.ofRecord(record), this.working()));
      if (open >= MAX_SHARES_PER_RECORD) {
        throw new BadRequestException(
          `At most ${MAX_SHARES_PER_RECORD} working links per record: revoke one first.`,
        );
      }
      const [created] = await tx
        .insert(recordShares)
        .values({
          subject: record.subject,
          recordId: record.recordId,
          fields,
          files: dto.files,
          tokenHash: hashOf(token),
          recipientEmail: dto.recipientEmail
            ? normalizeEmail(dto.recipientEmail)
            : null,
          createdBy: principalKey(principal),
          expiresAt,
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'share.created',
          targetType: 'share',
          targetId: created!.id,
          details: {
            subject: record.subject,
            recordId: record.recordId,
            fields,
            files: dto.files,
            recipientEmail: created!.recipientEmail,
            expiresAt: expiresAt.toISOString(),
          },
          ip,
        },
        tx,
      );
      return created!;
    });
    return {
      ...this.view(row),
      token,
      url: `${webUrl(this.config)}/shared#${token}`,
    };
  }

  /**
   * Revokes a link at once: its maker, or anyone who may share the record.
   * Revoking a revoked one changes nothing.
   */
  async revoke(
    principal: RequestPrincipal,
    record: RecordRef,
    id: string,
    ip?: string,
  ) {
    const [row] = await this.db
      .select()
      .from(recordShares)
      .where(and(eq(recordShares.id, id), this.ofRecord(record)));
    if (!row) {
      throw new NotFoundException(`Share ${id} not found.`);
    }
    if (row.createdBy !== principalKey(principal)) {
      await this.target(record.subject).assertCanShare(
        principal,
        record.recordId,
      );
    }
    if (row.revokedAt) return;
    await inTransaction(this.txHost, async (tx) => {
      await tx
        .update(recordShares)
        .set({ revokedAt: new Date(), revokedBy: principalKey(principal) })
        .where(and(eq(recordShares.id, id), isNull(recordShares.revokedAt)));
      await this.audit.record(
        principal,
        {
          action: 'share.revoked',
          targetType: 'share',
          targetId: id,
          details: { subject: row.subject, recordId: row.recordId },
          ip,
        },
        tx,
      );
    });
  }

  /** What a link shows, as its maker may read it now; audited `share.opened`. */
  async open(dto: OpenShareDto, ip?: string) {
    return this.inTenantOf(dto.token, async (share, maker, target) => {
      await this.assertCode(share, dto.code);
      const record = { subject: share.subject, recordId: share.recordId };
      const fields = await target.shared(maker, share.recordId, share.fields);
      if (!fields) throw notFound();
      const files =
        share.files && target.files
          ? await this.attachments.sharedFiles(maker, record, share.fields)
          : [];
      await inTransaction(this.txHost, async () => {
        await this.db
          .update(recordShares)
          .set({
            views: sql`${recordShares.views} + 1`,
            lastViewedAt: new Date(),
          })
          .where(eq(recordShares.id, share.id));
        await this.opened(share, ip);
      });
      return {
        subject: share.subject,
        fields,
        files,
        expiresAt: share.expiresAt.toISOString(),
      };
    });
  }

  /**
   * A signed download link to one of the shared files (5 minutes, as any
   * download link), handed out only while the link works: revoking it
   * stops new file links at once, and the last one given ends within
   * minutes. Audited `share.opened` with the file.
   */
  async fileLink(dto: OpenShareDto, attachmentId: string, ip?: string) {
    return this.inTenantOf(dto.token, async (share, maker, target) => {
      await this.assertCode(share, dto.code);
      if (!share.files || !target.files) {
        throw new NotFoundException(`Attachment ${attachmentId} not found.`);
      }
      if (!(await target.shared(maker, share.recordId, share.fields))) {
        throw notFound();
      }
      const link = await this.attachments.sharedDownload(
        maker,
        { subject: share.subject, recordId: share.recordId },
        share.fields,
        attachmentId,
      );
      await this.opened(share, ip, attachmentId);
      return link;
    });
  }

  /**
   * Mails a new code to the link's recipient (the last one stops working).
   * Answers the same whether or not the link has a recipient.
   */
  async sendCode(token: string) {
    await this.inTenantOf(token, async (share) => {
      if (!share.recipientEmail) return;
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      await this.db
        .update(recordShares)
        .set({
          codeHash: codeHashOf(share.id, code),
          codeExpiresAt: new Date(Date.now() + SHARE_CODE_MINUTES * 60_000),
          codeAttempts: 0,
        })
        .where(eq(recordShares.id, share.id));
      await this.mailQueue.send(ShareCodeMail, {
        to: { address: share.recipientEmail },
        data: { code, minutes: SHARE_CODE_MINUTES },
      });
    });
  }

  /** When records are gone for good: their links too. */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(recordShares)
      .where(
        and(
          eq(recordShares.subject, subject),
          inArray(recordShares.recordId, recordIds),
        ),
      );
  }

  /**
   * Runs `work` in the link's tenant with the working link, its maker as
   * they are now and its record's target; every refusal the one 404.
   */
  private async inTenantOf<T>(
    token: string,
    work: (share: Row, maker: Principal, target: ShareTarget) => Promise<T>,
  ) {
    const tenantId = TOKEN.exec(token)?.[1];
    if (!tenantId) throw notFound();
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant?.active) throw notFound();
    return this.tenancy.run(tenantId, async () => {
      const [share] = await this.db
        .select()
        .from(recordShares)
        .where(and(eq(recordShares.tokenHash, hashOf(token)), this.working()));
      const target = share && this.registry.find(share.subject);
      if (!share || !target || !share.createdBy.startsWith('user:')) {
        throw notFound();
      }
      // The maker as they are now: an ended membership ends their links.
      const maker = await this.users.inTenant(
        share.createdBy.slice('user:'.length),
        tenantId,
      );
      if (!maker || maker.tenantId !== tenantId) throw notFound();
      return work(share, maker, target);
    });
  }

  /**
   * A link to a recipient opens with the code last mailed to them, before
   * it ends and within its tries; a wrong code spends one (committed
   * before the 403).
   */
  private async assertCode(share: Row, code: string | undefined) {
    if (!share.recipientEmail) return;
    if (!code) {
      throw new ForbiddenException({
        code: 'share_code_required',
        message: 'This link opens with the code mailed to its recipient.',
      });
    }
    const given = Buffer.from(codeHashOf(share.id, code));
    const expected = Buffer.from(share.codeHash ?? '');
    const valid =
      share.codeExpiresAt !== null &&
      share.codeExpiresAt.getTime() > Date.now() &&
      share.codeAttempts < SHARE_CODE_ATTEMPTS &&
      given.length === expected.length &&
      timingSafeEqual(given, expected);
    if (!valid) {
      await this.db
        .update(recordShares)
        .set({ codeAttempts: sql`${recordShares.codeAttempts} + 1` })
        .where(eq(recordShares.id, share.id));
      throw new ForbiddenException({
        code: 'share_code_invalid',
        message: 'The code is wrong or has expired: ask for a new one.',
      });
    }
  }

  /** The audit entry of an opening: who holds the link is nobody in the tenant. */
  private opened(share: Row, ip: string | undefined, attachmentId?: string) {
    return this.audit.recordAnonymous(share.recipientEmail ?? 'Share link', {
      action: 'share.opened',
      targetType: 'share',
      targetId: share.id,
      details: {
        subject: share.subject,
        recordId: share.recordId,
        ...(attachmentId && { attachmentId }),
      },
      ip,
    });
  }

  private target(subject: string) {
    const target = this.registry.find(subject);
    if (!target) {
      throw new NotFoundException(`No records of ${subject} are shared.`);
    }
    return target;
  }

  private ofRecord(record: RecordRef) {
    return and(
      eq(recordShares.subject, record.subject),
      eq(recordShares.recordId, record.recordId),
    );
  }

  /** Not revoked, not expired. */
  private working() {
    return and(
      isNull(recordShares.revokedAt),
      gt(recordShares.expiresAt, new Date()),
    );
  }

  private view(row: Row): ShareView {
    return {
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      fields: row.fields,
      files: row.files,
      recipientEmail: row.recipientEmail,
      createdBy: row.createdBy,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      active: !row.revokedAt && row.expiresAt.getTime() > Date.now(),
      views: row.views,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
