import { tenantKey } from '../../core/tenancy/tenant-scope.js';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import { StorageDisk } from '@nestjs/storage';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, eq, sql } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { PlatformEnv } from '../platform.env.js';
import { REPORT_RUNNER_JOB } from '../platform.jobs.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { MailQueue } from '../../core/mail/mail-queue.js';
import { AccessService } from '../../iam/access/access.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type RequestPrincipal,
  principalKey,
  type SystemPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  type PersonalDataSource,
  PersonalDataRegistry,
} from '../account/personal-data.registry.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { apiClients } from '../../iam/iam.tables.js';
import { defineResource } from '../../iam/resources/resource.js';
import { DataTransferRegistry } from '../data-transfer/data-transfer.registry.js';
import { DataTransferService } from '../data-transfer/data-transfer.service.js';
import type {
  TransferFinished,
  TransferFormat,
} from '../data-transfer/data-transfer.types.js';
import { nextRunTime } from './report-time.js';
import { ReportFailedMail, ReportReadyMail } from './report.mails.js';
import { REPORT_LIST } from './report.list.js';
import type { CreateReportDto, UpdateReportDto } from './report.schemas.js';
import { type ReportScheduleRow, reportSchedules } from './reports.tables.js';

/** Audited as `report.created`, `report.updated` (what changed), `report.deleted`. */
export const REPORT = defineResource({ subject: 'Report', audit: {} });

/** At most this many active reports per owner. */
export const MAX_ACTIVE_REPORTS = 20;

/** The transfers a report started carry this tag: `report:<id>`. */
const TAG = 'report:';

const view = (row: ReportScheduleRow) => ({
  id: row.id,
  name: row.name,
  exporter: row.exporter,
  format: row.format as TransferFormat,
  filters: row.filters,
  timezone: row.timezone,
  schedule: row.schedule,
  recipients: row.recipients,
  active: row.active,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastStatus: row.lastStatus ?? null,
  lastTransferId: row.lastTransferId ?? null,
  nextRunAt: row.nextRunAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/**
 * Scheduled reports: an export a user or an API client asked for once, run
 * for them on a schedule (daily, weekly, monthly at an hour of their time
 * zone), its file mailed to the recipients with a signed link. Each
 * principal sees and changes only their own. The runner
 * (`ReportRunnerJob`) starts the due ones every hour; the export runs as
 * any other (`DataTransferService.startExport`, as the owner, checked
 * again on the worker), and its end is heard here (`onFinished`) to mail
 * the recipients.
 */
@Injectable()
export class ReportsService implements PersonalDataSource {
  private readonly logger = new Logger('Reports');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly transfers: DataTransferService,
    private readonly registry: DataTransferRegistry,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly mailQueue: MailQueue,
    private readonly disk: StorageDisk,
    private readonly i18n: I18nService,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly access: AccessService,
    personalData: PersonalDataRegistry,
  ) {
    registry.onFinished((finished) => this.finished(finished));
    personalData.register(this);
  }

  /** As a personal data source: the person's reports are in their export… */
  readonly name = 'report';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.owner, principalKey(user)));
    if (rows.length) yield rows.map(view);
  }

  /** …and go with their account (the addresses they mail are theirs to give). */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .delete(reportSchedules)
      .where(eq(reportSchedules.owner, principalKey(user)));
  }

  /** A page of the principal's reports, newest first unless the query sorts. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const where = and(
      eq(reportSchedules.owner, principalKey(principal)),
      REPORT_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(reportSchedules)
        .where(and(where, afterCursor(reportSchedules.id, query)))
        .orderBy(...pageOrder(reportSchedules.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, reportSchedules, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async get(principal: RequestPrincipal, id: string) {
    return view(await this.findOwn(principal, id));
  }

  async create(principal: RequestPrincipal, dto: CreateReportDto, ip?: string) {
    await this.check(principal, dto.exporter, dto.filters);
    const recipients =
      dto.recipients ?? (principal.kind === 'user' ? [principal.email] : null);
    if (!recipients) {
      throw invalid([
        {
          path: 'recipients',
          message: 'An API client names the recipients.',
        },
      ]);
    }
    const timezone =
      dto.timezone ??
      (principal.kind === 'user' ? principal.timezone : null) ??
      this.config.get('APP_TIMEZONE', { infer: true });
    const row = await inTransaction(this.txHost, async (tx) => {
      if (dto.active) {
        await this.assertRoomFor(principal);
      }
      const [created] = await tx
        .insert(reportSchedules)
        .values({
          owner: principalKey(principal),
          name: dto.name,
          exporter: dto.exporter,
          format: dto.format,
          filters: dto.filters,
          timezone,
          schedule: dto.schedule,
          recipients,
          active: dto.active,
          nextRunAt: nextRunTime(dto.schedule, new Date(), timezone),
        })
        .returning();
      await this.audit.recordChange(
        principal,
        REPORT,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    });
    return view(row);
  }

  /**
   * Only what is sent changes; the next run is computed again from now
   * when the schedule, the zone or `active` is sent.
   */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateReportDto,
    ip?: string,
  ) {
    const report = await this.findOwn(principal, id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateReportDto;
    if (Object.keys(values).length === 0) {
      return view(report);
    }
    if (values.exporter !== undefined || values.filters !== undefined) {
      await this.check(
        principal,
        values.exporter ?? report.exporter,
        values.filters ?? report.filters,
      );
    }
    const schedule = values.schedule ?? report.schedule;
    const timezone = values.timezone ?? report.timezone;
    const reschedule =
      values.schedule !== undefined ||
      values.timezone !== undefined ||
      values.active !== undefined;
    const row = await inTransaction(this.txHost, async (tx) => {
      if (values.active && !report.active) {
        await this.assertRoomFor(principal);
      }
      const [updated] = await tx
        .update(reportSchedules)
        .set({
          ...values,
          ...(reschedule && {
            nextRunAt: nextRunTime(schedule, new Date(), timezone),
          }),
        })
        .where(eq(reportSchedules.id, id))
        .returning();
      await this.audit.recordChange(
        principal,
        REPORT,
        { action: 'updated', id, before: report, after: updated! },
        tx,
        ip,
      );
      return updated!;
    });
    return view(row);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const report = await this.findOwn(principal, id);
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(reportSchedules).where(eq(reportSchedules.id, id));
      await this.audit.recordChange(
        principal,
        REPORT,
        { action: 'deleted', id, before: report },
        tx,
        ip,
      );
    });
  }

  /** Runs one of the principal's reports now; its schedule stays as it is. */
  async runNow(principal: RequestPrincipal, id: string, ip?: string) {
    const report = await this.findOwn(principal, id);
    // A 400 (not the export's 403/404) when the owner may no longer run it;
    // filters on a field they may no longer read: a 403 field_forbidden.
    await this.check(principal, report.exporter, report.filters);
    const started = await this.start(principal, report, {
      trigger: 'manual',
      ip,
    });
    if (!started) {
      throw new NotFoundException(`Report ${id} not found.`); // deleted meanwhile
    }
    return started;
  }

  /**
   * Starts a report's export as `principal` (its owner): the transfer is
   * tagged with the report, so its end mails the recipients.
   *
   * The run is claimed first, in one transaction: the transfer's id (chosen
   * now) and `lastRunAt` are stored, and a scheduled run moves `nextRunAt`
   * past `now` (computed from the row as it is now) only where it is still
   * the value the runner read: a second runner gets nothing to claim (null).
   * A manual run leaves the schedule alone. If the export can't start, the
   * claim is undone (the runner tries again next hour) and the error thrown.
   */
  async start(
    principal: RequestPrincipal,
    report: ReportScheduleRow,
    options: { trigger: 'manual' | 'schedule'; now?: Date; ip?: string },
  ) {
    const now = options.now ?? new Date();
    const transferId = randomUUID();
    const scheduled = options.trigger === 'schedule';
    const claim = await inTransaction(this.txHost, async (tx) => {
      const [current] = await tx
        .select()
        .from(reportSchedules)
        .where(eq(reportSchedules.id, report.id))
        .for('update');
      if (
        !current ||
        (scheduled &&
          (!current.active ||
            current.nextRunAt.getTime() !== report.nextRunAt.getTime()))
      ) {
        return null;
      }
      const [claimed] = await tx
        .update(reportSchedules)
        .set({
          lastRunAt: now,
          lastTransferId: transferId,
          ...(scheduled && {
            nextRunAt: nextRunTime(current.schedule, now, current.timezone),
          }),
        })
        .where(
          and(
            eq(reportSchedules.id, report.id),
            eq(reportSchedules.nextRunAt, current.nextRunAt),
          ),
        )
        .returning();
      return claimed ? { before: current, claimed } : null;
    });
    if (!claim) {
      return null; // another run took it
    }
    const { before, claimed } = claim;
    let started;
    try {
      started = await this.transfers.startExport(principal, {
        name: claimed.exporter,
        format: claimed.format as TransferFormat,
        filters: claimed.filters,
        timezone: claimed.timezone,
        tag: `${TAG}${claimed.id}`,
        id: transferId,
        details: { report: claimed.id, trigger: options.trigger },
      });
    } catch (error) {
      await this.db
        .update(reportSchedules)
        .set({
          lastRunAt: before.lastRunAt,
          lastTransferId: before.lastTransferId,
          nextRunAt: before.nextRunAt,
        })
        .where(
          and(
            eq(reportSchedules.id, report.id),
            eq(reportSchedules.lastTransferId, transferId),
          ),
        );
      throw error;
    }
    await this.audit.record(principal, {
      action: 'report.ran',
      targetType: 'report',
      targetId: report.id,
      details: { transferId: started.id, trigger: options.trigger },
      ip: options.ip,
    });
    return started;
  }

  /** Moves a scheduled run that could not start (refused filters) past `now`; `by`: the runner. */
  async skip(
    report: ReportScheduleRow,
    now: Date,
    reason: string,
    by: SystemPrincipal,
  ) {
    await inTransaction(this.txHost, async () => {
      await this.db
        .update(reportSchedules)
        .set({
          lastStatus: 'failed',
          nextRunAt: nextRunTime(report.schedule, now, report.timezone),
        })
        .where(eq(reportSchedules.id, report.id));
      await this.audit.record(by, {
        action: 'report.skipped',
        targetType: 'report',
        targetId: report.id,
        details: { reason },
      });
    });
  }

  /** Stops a report whose owner is gone or may no longer run it; `by`: the runner. */
  async deactivate(
    report: ReportScheduleRow,
    reason: string,
    by: SystemPrincipal,
  ) {
    await inTransaction(this.txHost, async () => {
      await this.db
        .update(reportSchedules)
        .set({ active: false })
        .where(eq(reportSchedules.id, report.id));
      await this.audit.record(by, {
        action: 'report.deactivated',
        targetType: 'report',
        targetId: report.id,
        details: { owner: report.owner, reason },
      });
    });
  }

  /**
   * The report's owner as a principal acting in the report's tenant, as
   * they are now; null when they were deactivated (or deleted) since, or
   * are no longer a member of that tenant (docs/tenancy.md). Called in the
   * report's tenant (the runner walks them).
   */
  async owner(report: ReportScheduleRow): Promise<RequestPrincipal | null> {
    const [kind, id] = report.owner.split(':') as [string, string];
    if (kind === 'user') {
      const user = await this.users.inTenant(id, report.tenantId);
      return user?.tenantId === report.tenantId ? user : null;
    }
    if (kind !== 'client') {
      return null; // never the system's: reports are made over HTTP
    }
    const [client] = await this.db
      .select({
        name: apiClients.name,
        active: apiClients.active,
        dailyQuota: apiClients.dailyQuota,
        tenantId: apiClients.tenantId,
      })
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client?.active && client.tenantId === report.tenantId
      ? {
          kind: 'client',
          id,
          name: client.name,
          dailyQuota: client.dailyQuota,
          tenantId: client.tenantId,
        }
      : null;
  }

  /** Whether the owner may still run the report's export. */
  async mayRun(principal: RequestPrincipal, exporterName: string) {
    const exporter = this.registry.exporter(exporterName);
    return !!exporter && (await this.transfers.mayExport(principal, exporter));
  }

  /**
   * The exporter and filters checked as `POST /data/exports` checks them,
   * as 400s on the fields: the exporter must exist and be the principal's
   * to run, its filters parse.
   */
  private async check(
    principal: RequestPrincipal,
    exporterName: string,
    filters: Record<string, string>,
  ) {
    const exporter = this.registry.exporter(exporterName);
    if (!exporter || !(await this.transfers.mayExport(principal, exporter))) {
      throw invalid([
        {
          path: 'exporter',
          message: `No export named "${exporterName}" you may run (GET /v1/data lists yours).`,
        },
      ]);
    }
    const parsed = exporter.filters?.safeParse(filters);
    if (parsed && !parsed.success) {
      throw invalid(
        parsed.error.issues.map((issue) => ({
          path: ['filters', ...issue.path].join('.'),
          message: issue.message,
        })),
      );
    }
    if (parsed) {
      // A 403 field_forbidden as the export itself would answer (each run checks again).
      await this.access.assertQueryFields(
        principal,
        exporter.subject,
        parsed.data as ListQuery,
        // Among the rows its export reaches.
        { reach: exporter.action ?? 'read' },
      );
    }
  }

  /** A 400 when the principal has MAX_ACTIVE_REPORTS active reports already. */
  private async assertRoomFor(principal: RequestPrincipal) {
    // One count at a time per owner (in the caller's transaction): two
    // creates at once can't both take the last place.
    await this.db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${tenantKey(`reports:${principalKey(principal)}`)}))`,
    );
    const [row] = await this.db
      .select({ active: count() })
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.owner, principalKey(principal)),
          eq(reportSchedules.active, true),
        ),
      );
    if ((row?.active ?? 0) >= MAX_ACTIVE_REPORTS) {
      throw invalid([
        {
          path: 'active',
          message: `At most ${MAX_ACTIVE_REPORTS} active reports: pause or delete one first.`,
        },
      ]);
    }
  }

  private async findOwn(principal: RequestPrincipal, id: string) {
    const [row] = await this.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.id, id),
          eq(reportSchedules.owner, principalKey(principal)),
        ),
      );
    if (!row) {
      throw new NotFoundException(`Report ${id} not found.`);
    }
    return row;
  }

  /**
   * A transfer finished (on the worker): when a report started it, the
   * report's status is kept (unless a later run superseded it) and audited,
   * and the recipients get the link (or word of the failure), once per
   * transfer, in the owner's language. The owner's own address is the
   * `To`; every other recipient is in `Bcc`, so nobody sees the others.
   * The runner's doing (`system:report-runner`), as the run's start was.
   */
  private async finished(event: TransferFinished) {
    const tag = event.job.kind === 'export' ? event.job.tag : undefined;
    if (!tag?.startsWith(TAG)) {
      return;
    }
    const reportId = tag.slice(TAG.length);
    const report = await this.system.run(
      REPORT_RUNNER_JOB,
      async (system, tx) => {
        const [row] = await tx
          .select()
          .from(reportSchedules)
          .where(eq(reportSchedules.id, reportId));
        if (!row) {
          return null; // deleted meanwhile: nobody to tell
        }
        await tx
          .update(reportSchedules)
          .set({ lastStatus: event.status })
          .where(
            and(
              eq(reportSchedules.id, reportId),
              eq(reportSchedules.lastTransferId, event.id),
            ),
          );
        await this.audit.record(
          system,
          {
            action: 'report.finished',
            targetType: 'report',
            targetId: reportId,
            details: { reportId, transferId: event.id, status: event.status },
          },
          tx,
        );
        return row;
      },
    );
    if (!report) {
      return;
    }
    const owner = event.job.principal;
    const locale =
      (owner.kind === 'user' ? owner.locale : null) ?? this.i18n.defaultLocale;
    const ownAddress =
      owner.kind === 'user' ? owner.email.toLowerCase() : undefined;
    const to = report.recipients.filter(
      (address) => address.toLowerCase() === ownAddress,
    );
    const bcc = report.recipients.filter(
      (address) => address.toLowerCase() !== ownAddress,
    );
    const jobId = `report-${event.id}`;
    if (event.status === 'completed' && event.result.kind === 'export') {
      const ttl = this.config.get('REPORT_LINK_TTL', { infer: true });
      const url = await this.disk.signedUrl(event.result.key, {
        expiresIn: ttl,
      });
      await this.mailQueue.send(
        ReportReadyMail,
        {
          to,
          bcc,
          data: {
            report: report.name,
            url,
            expiresAt: new Date(Date.now() + ttl),
            rows: event.result.rows,
            timezone: report.timezone,
          },
          locale,
        },
        { jobId },
      );
    } else {
      this.logger.warn('A report failed', {
        report: report.id,
        transfer: event.id,
        error: event.status === 'failed' ? event.error : undefined,
      });
      await this.mailQueue.send(
        ReportFailedMail,
        { to, bcc, data: { report: report.name }, locale },
        { jobId },
      );
    }
  }
}

/** A refusal a schedule can't get past by waiting (its filters no longer parse): a 4xx. */
export const isRefusal = (error: unknown) =>
  error instanceof HttpException && error.getStatus() < 500;
