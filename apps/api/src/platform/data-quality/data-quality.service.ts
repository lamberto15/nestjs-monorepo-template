import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias, type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { afterCursor } from '../../core/http/pagination.js';
import {
  type TenantEnvelope,
  withTenant,
} from '../../core/tenancy/tenant-job.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  DataQualityRegistry,
  type DataQualityTarget,
  type QualityTable,
} from './data-quality.registry.js';
import type {
  DataQualityFindingView,
  DataQualityScanView,
  FindingsQuery,
} from './data-quality.schemas.js';
import {
  type DataQualityFindingRow,
  dataQualityFindings,
  type DataQualityScanRow,
  dataQualityScans,
  type QualityCheck,
  type QualitySeverity,
} from './data-quality.tables.js';

export const DATA_QUALITY = 'data-quality';
/** Records one job checks: a scan is many short jobs, never one long one. */
export const SCAN_BATCH = 500;
/** A scan queued or running longer than this is taken as lost (its worker gone): a new one may start. */
const SCAN_STALE_MS = 60 * 60 * 1000;

/** One batch of a scan: the subject's records after `after`, by id. */
export interface DataQualityJob extends TenantEnvelope {
  scanId: string;
  subject: string;
  after?: string;
}

/** A problem found on a record now. */
interface Found {
  recordId: string;
  check: QualityCheck;
  field: string;
  severity: QualitySeverity;
  detail: Record<string, string> | null;
}

const findings = dataQualityFindings;

/** A column's key in its table (`deletedAt`): what an alias of the table names it by. */
const keyOf = (table: PgTable, column: AnyPgColumn) =>
  Object.entries(getTableColumns(table)).find(([, c]) => c === column)![0];

/** Text that is empty once trimmed counts as missing, as null does. */
const isText = (column: AnyPgColumn) =>
  column.columnType === 'PgText' || column.columnType === 'PgVarchar';

const live = (table: QualityTable) =>
  table.deletedAt ? isNull(table.deletedAt) : undefined;

/**
 * Data-quality checks over the records features declare
 * (docs/data-quality.md): recommended fields left empty and duplicate
 * candidates (suggestions), references to records in the recycle bin
 * (errors). A scan runs on the queue in bounded batches and records its
 * progress; it adds the findings that hold and deletes those that no
 * longer do. Nothing here changes a record: a person fixes it, or
 * dismisses the finding as right as it is.
 *
 * Who may read DataQuality sees the findings on the records they may read,
 * never on a field their permissions hide (or show on some records only):
 * a finding would tell whether its value is empty or shared.
 */
@Injectable()
export class DataQualityService {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: DataQualityRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @InjectQueue(DATA_QUALITY) private readonly queue: Queue<DataQualityJob>,
  ) {}

  /** The open and dismissed findings per subject the principal may read, and the last scan. */
  async summary(principal: Principal) {
    const [last] = await this.db
      .select()
      .from(dataQualityScans)
      .orderBy(desc(dataQualityScans.createdAt), desc(dataQualityScans.id))
      .limit(1);
    const subjects = [];
    for (const target of this.registry.all()) {
      if (!(await this.access.can(principal, 'read', target.subject))) {
        continue;
      }
      const rows = await this.db
        .select({
          severity: findings.severity,
          total: count(),
          dismissed: count(findings.dismissedAt),
        })
        .from(findings)
        .innerJoin(target.table, eq(target.id, findings.recordId))
        .where(await this.visible(principal, target))
        .groupBy(findings.severity);
      const open = (severity: QualitySeverity) => {
        const row = rows.find((r) => r.severity === severity);
        return row ? row.total - row.dismissed : 0;
      };
      subjects.push({
        subject: target.subject,
        errors: open('error'),
        suggestions: open('suggestion'),
        dismissed: rows.reduce((sum, r) => sum + r.dismissed, 0),
      });
    }
    return { lastScan: last ? scanView(last) : null, subjects };
  }

  /** A page of a subject's findings the principal may see, newest first. */
  async findings(principal: Principal, subject: string, query: FindingsQuery) {
    const target = this.target(subject);
    const rows = await this.db
      .select(getTableColumns(findings))
      .from(findings)
      .innerJoin(target.table, eq(target.id, findings.recordId))
      .where(
        and(
          await this.visible(principal, target),
          query.dismissed
            ? isNotNull(findings.dismissedAt)
            : isNull(findings.dismissedAt),
          query.severity ? eq(findings.severity, query.severity) : undefined,
          query.check ? eq(findings.check, query.check) : undefined,
          afterCursor(findings.id, query),
        ),
      )
      .orderBy(desc(findings.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    return {
      items: items.map(findingView),
      nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
    };
  }

  /** Starts a scan of every subject's records: one at a time per tenant (409 `scan_running`). */
  async startScan(principal: Principal, ip?: string) {
    const targets = this.registry.all();
    const scan = await inTransaction(this.txHost, async (tx) => {
      const [running] = await tx
        .select()
        .from(dataQualityScans)
        .where(inArray(dataQualityScans.status, ['queued', 'running']))
        .orderBy(desc(dataQualityScans.createdAt))
        .limit(1)
        .for('update');
      if (running) {
        if (Date.now() - running.createdAt.getTime() < SCAN_STALE_MS) {
          throw new ConflictException({
            code: 'scan_running',
            message: 'A data-quality scan is already running.',
          });
        }
        await tx
          .update(dataQualityScans)
          .set({ status: 'failed', finishedAt: new Date() })
          .where(eq(dataQualityScans.id, running.id));
      }
      let total = 0;
      for (const target of targets) {
        const [row] = await tx
          .select({ n: count() })
          .from(target.table)
          .where(live(target));
        total += row!.n;
      }
      const [created] = await tx
        .insert(dataQualityScans)
        .values({
          total,
          status: targets.length ? 'queued' : 'completed',
          findings: targets.length ? null : 0,
          finishedAt: targets.length ? null : new Date(),
          startedBy: principalKey(principal),
          // The app's clock, as the findings' checkedAt: what the last sweep compares.
          createdAt: new Date(),
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'data-quality.scan-started',
          targetType: 'dataQualityScan',
          targetId: created!.id,
          details: { total },
          ip,
        },
        tx,
      );
      return created!;
    });
    if (targets[0]) {
      try {
        await this.queue.add(
          'batch',
          withTenant({ scanId: scan.id, subject: targets[0].subject }),
        );
      } catch (error) {
        await this.fail(scan.id);
        throw error;
      }
    }
    return scanView(scan);
  }

  /**
   * One batch of a scan (DataQualityProcessor): checks the next SCAN_BATCH
   * records of the job's subject and records the progress. Answers the next
   * job, or null when the scan is done (or gone).
   */
  async batch(job: DataQualityJob): Promise<DataQualityJob | null> {
    const [scan] = await this.db
      .select()
      .from(dataQualityScans)
      .where(eq(dataQualityScans.id, job.scanId));
    if (!scan || scan.status === 'failed' || scan.status === 'completed') {
      return null;
    }
    const targets = this.registry.all();
    const index = targets.findIndex((t) => t.subject === job.subject);
    const target = targets[index];
    let ids: string[] = [];
    if (target) {
      ids = (
        await this.db
          .select({ id: target.id })
          .from(target.table)
          .where(
            and(live(target), job.after ? gt(target.id, job.after) : undefined),
          )
          .orderBy(asc(target.id))
          .limit(SCAN_BATCH)
      ).map((row) => row.id as string);
      await this.record(target, ids, new Date());
    }
    await this.db
      .update(dataQualityScans)
      .set({
        status: 'running',
        scanned: sql`${dataQualityScans.scanned} + ${ids.length}`,
      })
      .where(eq(dataQualityScans.id, scan.id));
    if (target && ids.length === SCAN_BATCH) {
      return { ...job, after: ids.at(-1) };
    }
    // The subject is done: what this scan didn't find again no longer holds.
    await this.db
      .delete(findings)
      .where(
        and(
          eq(findings.subject, job.subject),
          lt(findings.checkedAt, scan.createdAt),
        ),
      );
    const next = targets[index + 1];
    if (next) {
      return { tenantId: job.tenantId, scanId: scan.id, subject: next.subject };
    }
    const [open] = await this.db
      .select({ n: count() })
      .from(findings)
      .where(isNull(findings.dismissedAt));
    await this.db
      .update(dataQualityScans)
      .set({ status: 'completed', findings: open!.n, finishedAt: new Date() })
      .where(eq(dataQualityScans.id, scan.id));
    return null;
  }

  /** A scan that failed for good (DataQualityProcessor). */
  async fail(scanId: string) {
    await this.db
      .update(dataQualityScans)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(eq(dataQualityScans.id, scanId));
  }

  /** Queues a scan's next batch. */
  queueNext(job: DataQualityJob) {
    return this.queue.add('batch', job);
  }

  /** Dismisses a finding: right as it is. It stays dismissed while it holds. */
  async dismiss(principal: Principal, id: string, ip?: string) {
    const finding = await this.findOne(principal, id);
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(findings)
        .set({ dismissedAt: new Date(), dismissedBy: principalKey(principal) })
        .where(eq(findings.id, id))
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'data-quality.finding-dismissed',
          targetType: 'dataQualityFinding',
          targetId: id,
          details: {
            subject: finding.subject,
            recordId: finding.recordId,
            check: finding.check,
            field: finding.field,
          },
          ip,
        },
        tx,
      );
      return updated!;
    });
    return findingView(row);
  }

  /** Checks a finding's record again now: the finding if it still holds. */
  async recheck(principal: Principal, id: string) {
    const finding = await this.findOne(principal, id);
    await this.recheckRecord(finding.subject, finding.recordId);
    const [still] = await this.db
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.subject, finding.subject),
          eq(findings.recordId, finding.recordId),
          eq(findings.check, finding.check),
          eq(findings.field, finding.field),
        ),
      );
    return { resolved: !still, finding: still ? findingView(still) : null };
  }

  /** Checks one record again: its findings now. */
  private async recheckRecord(subject: string, recordId: string) {
    const target = this.target(subject);
    const now = new Date();
    await inTransaction(this.txHost, async () => {
      await this.record(target, [recordId], now);
      await this.db
        .delete(findings)
        .where(
          and(
            eq(findings.subject, subject),
            eq(findings.recordId, recordId),
            lt(findings.checkedAt, now),
          ),
        );
    });
  }

  /** A finding the principal may see, or a 404 (the same for one they may not). */
  private async findOne(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(findings)
      .where(eq(findings.id, id));
    const target = row && this.registry.find(row.subject);
    if (target) {
      const [shown] = await this.db
        .select({ id: findings.id })
        .from(findings)
        .innerJoin(target.table, eq(target.id, findings.recordId))
        .where(and(eq(findings.id, id), await this.visible(principal, target)));
      if (shown) return row;
    }
    throw new NotFoundException({
      code: 'finding_not_found',
      message: `No data-quality finding ${id} that you may see.`,
    });
  }

  /** The findings of a subject the principal may see: on records they may read, on fields shown to them. */
  private async visible(
    principal: Principal,
    target: DataQualityTarget,
  ): Promise<SQL | undefined> {
    const hidden = await this.access.unmatchableFields(
      principal,
      'read',
      target.subject,
    );
    return and(
      eq(findings.subject, target.subject),
      hidden.length ? notInArray(findings.field, hidden) : undefined,
      await this.access.sqlFilter(principal, target.subject, 'read'),
    );
  }

  private target(subject: string) {
    const target = this.registry.find(subject);
    if (!target) {
      throw new NotFoundException({
        code: 'subject_not_found',
        message: `No data-quality checks for "${subject}".`,
      });
    }
    return target;
  }

  /** Runs the checks on these records and writes what holds, found at `now`. */
  private async record(target: DataQualityTarget, ids: string[], now: Date) {
    if (ids.length === 0) return;
    const found = await this.check(target, ids);
    if (found.length === 0) return;
    await this.db
      .insert(findings)
      .values(
        found.map((f) => ({ ...f, subject: target.subject, checkedAt: now })),
      )
      .onConflictDoUpdate({
        target: [
          findings.tenantId,
          findings.subject,
          findings.recordId,
          findings.check,
          findings.field,
        ],
        // Dismissed stays dismissed: the problem is the same one.
        set: {
          severity: sql`excluded.severity`,
          detail: sql`excluded.detail`,
          checkedAt: now,
        },
      });
  }

  /** The problems these records have now (the checks: docs/data-quality.md). */
  private async check(
    target: DataQualityTarget,
    ids: string[],
  ): Promise<Found[]> {
    const found: Found[] = [];
    const ofBatch = inArray(target.id, ids);
    for (const [field, column] of Object.entries(target.recommended)) {
      const empty = isText(column)
        ? or(isNull(column), eq(sql`trim(${column})`, ''))
        : isNull(column);
      const rows = await this.db
        .select({ id: target.id })
        .from(target.table)
        .where(and(ofBatch, empty));
      for (const row of rows) {
        found.push({
          recordId: row.id as string,
          check: 'missing',
          field,
          severity: 'suggestion',
          detail: null,
        });
      }
    }
    for (const [field, reference] of Object.entries(target.references)) {
      const to = reference.to();
      // A missing record can't be referred to (the key); one in the recycle bin can.
      if (!to.deletedAt) continue;
      const referenced = alias(to.table, 'referenced') as unknown as Record<
        string,
        AnyPgColumn
      >;
      const rows = await this.db
        .select({ id: target.id, to: reference.column })
        .from(target.table)
        .innerJoin(
          referenced as unknown as PgTable,
          eq(referenced[keyOf(to.table, to.id)]!, reference.column),
        )
        .where(
          and(ofBatch, isNotNull(referenced[keyOf(to.table, to.deletedAt)]!)),
        );
      for (const row of rows) {
        found.push({
          recordId: row.id as string,
          check: 'reference',
          field,
          severity: 'error',
          detail: { referencedId: row.to as string },
        });
      }
    }
    for (const [field, column] of Object.entries(target.duplicates)) {
      const key = sql<string>`lower(trim(${column}))`;
      const rows = await this.db
        .select({ id: target.id, key })
        .from(target.table)
        .where(and(ofBatch, isNotNull(column), sql`trim(${column}) <> ''`));
      if (rows.length === 0) continue;
      const same = await this.db
        .select({ id: target.id, key })
        .from(target.table)
        .where(
          and(
            live(target),
            inArray(
              key,
              rows.map((row) => row.key),
            ),
          ),
        )
        .orderBy(asc(target.id));
      for (const row of rows) {
        const other = same.find((s) => s.key === row.key && s.id !== row.id);
        if (!other) continue;
        found.push({
          recordId: row.id as string,
          check: 'duplicate',
          field,
          severity: 'suggestion',
          detail: { duplicateOf: other.id as string },
        });
      }
    }
    return found;
  }
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

function scanView(row: DataQualityScanRow): DataQualityScanView {
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    scanned: row.scanned,
    findings: row.findings,
    startedBy: row.startedBy,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

function findingView(row: DataQualityFindingRow): DataQualityFindingView {
  return {
    id: row.id,
    subject: row.subject,
    recordId: row.recordId,
    check: row.check,
    field: row.field,
    severity: row.severity,
    detail: row.detail ?? null,
    checkedAt: row.checkedAt.toISOString(),
    dismissedAt: iso(row.dismissedAt),
    dismissedBy: row.dismissedBy,
  };
}
