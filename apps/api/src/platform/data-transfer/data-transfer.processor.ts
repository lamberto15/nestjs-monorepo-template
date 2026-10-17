import { HttpException, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { StorageDisk } from '@nestjs/storage';
import type { Job } from 'bullmq';
import type { CoreEnv } from '../../core/config/core.env.js';
import { inTenantOf, TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { stillActive } from '../queues/still-active.js';
import { isTenantFileKey } from '../storage/storage.config.js';
import { Realtime } from '../realtime/realtime.service.js';
import { DataTransferRegistry } from './data-transfer.registry.js';
import {
  DATA_TRANSFERS,
  readerZone,
  TRANSFER_LINK_TTL,
  jobFileKey,
} from './data-transfer.service.js';
import type {
  ImportRowError,
  TransferColumn,
  TransferFormat,
  TransferJob,
  TransferResult,
} from './data-transfer.types.js';
import { CONTENT_TYPES, createWriter, readRecords } from './formats.js';
import { columnsOf } from './import-columns.js';

/** BullMQ's reason for a job it fails itself: stalled past `maxStalledCount` (the worker died mid-run). */
export const STALLED_REASON = 'job stalled more than allowable limit';

/** An import reports its progress every this many rows. */
const PROGRESS_EVERY = 500;
/** Errors kept in an import's report: past it, the import is stopped as unusable. */
const MAX_ERRORS = 10_000;

/**
 * The fields a row sets, as a write route sees them: an empty value (an
 * empty cell, no custom value) sets nothing, so it needs no permission.
 */
export const valuesSet = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([field, value]) => [
      field,
      value === '' ||
      value === null ||
      (typeof value === 'object' &&
        !(value instanceof Date) &&
        Object.keys(value).length === 0)
        ? undefined
        : value,
    ]),
  );

/**
 * A row's refusal, from what a write threw: a 4xx (Nest's exceptions, as
 * the route answers them) names its fields when it can. Undefined for
 * anything else (the database gone): that fails the import.
 */
export function refusal(
  error: unknown,
  row: number,
): ImportRowError[] | undefined {
  if (!(error instanceof HttpException) || error.getStatus() >= 500) {
    return undefined;
  }
  const body = error.getResponse();
  // The shapes this API's exceptions use: validation_failed (`errors`),
  // field_forbidden (`fields`), Nest's own (`message`, a list for some).
  const { errors, fields, message } = (
    typeof body === 'object' ? body : { message: body }
  ) as {
    errors?: { path?: string; message?: string }[];
    fields?: string[];
    message?: string | string[];
  };
  if (Array.isArray(errors) && errors.length) {
    return errors.map((issue) => ({
      row,
      path: issue.path ?? '',
      message: issue.message ?? error.message,
    }));
  }
  const text = Array.isArray(message)
    ? message.join(' ')
    : (message ?? error.message);
  if (Array.isArray(fields) && fields.length) {
    return fields.map((field) => ({ row, path: field, message: text }));
  }
  return [{ row, path: '', message: text }];
}

/**
 * Runs exports and imports on the workers (APP_ROLE worker or all), in
 * the tenant the job was started in (TenantWorkerHost restores it from the
 * job's `tenantId` before anything runs: every query, file and audit entry
 * is that tenant's). The principal is checked again when the job starts: a
 * user deactivated in the meantime, or no longer a member of the tenant,
 * gets nothing.
 */
@Processor(DATA_TRANSFERS, { concurrency: 2 })
export class DataTransferProcessor extends TenantWorkerHost<
  TransferJob,
  TransferResult
> {
  private readonly logger = new Logger('DataTransfer');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly registry: DataTransferRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly disk: StorageDisk,
    private readonly realtime: Realtime,
    private readonly users: UsersRepository,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {
    super();
  }

  async handle(job: Job<TransferJob>): Promise<TransferResult> {
    let result: TransferResult;
    try {
      result = await this.run(job);
    } catch (error) {
      // Failed for good (transfers get one attempt, unless queued with more):
      // the listeners hear it.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.registry.finished({
          id: job.id!,
          job: job.data,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    await this.registry.finished({
      id: job.id!,
      job: job.data,
      status: 'completed',
      result,
    });
    return result;
  }

  /**
   * A transfer whose worker died mid-run stalls; past the limit, the next
   * worker to pick it up fails it without calling `process()` (an
   * unrecoverable error, no retry), and this is where that worker says so:
   * the listeners (a scheduled report's failure mail) hear of it here. Any
   * other failure `process()` told them itself.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<TransferJob> | undefined, error: Error) {
    if (!job || error.message !== STALLED_REASON) {
      return;
    }
    this.logger.warn('A transfer stalled and was failed', { id: job.id });
    // Outside process(): the listeners (a report's failure) write in the job's tenant.
    await inTenantOf(job.data, () =>
      this.registry.finished({
        id: job.id!,
        job: job.data,
        status: 'failed',
        error: error.message,
      }),
    );
  }

  private async run(job: Job<TransferJob>): Promise<TransferResult> {
    const principal = await stillActive(
      job.data.principal,
      this.users,
      this.db,
      // An account export runs in no tenant: the account itself must be active.
      { account: job.data.tenantId === null },
    );
    if (!principal) {
      throw new Error(
        'The account that started this transfer is no longer active.',
      );
    }
    return job.data.kind === 'export'
      ? this.export(
          job as Job<Extract<TransferJob, { kind: 'export' }>>,
          principal,
        )
      : this.import(
          job as Job<Extract<TransferJob, { kind: 'import' }>>,
          principal,
        );
  }

  private async export(
    job: Job<Extract<TransferJob, { kind: 'export' }>>,
    principal: Principal,
  ): Promise<TransferResult> {
    const exporter = this.registry.exporter(job.data.name)!;
    const action = exporter.action ?? 'read';
    const key = jobFileKey(job.data, `${job.id}.${job.data.format}`);
    // Parsed here, not at enqueue: the job is JSON, so parsed values (dates)
    // would arrive as strings. The request already checked them.
    const filters = exporter.filters
      ? exporter.filters.parse(job.data.filters ?? {})
      : {};
    let rows = 0;
    const columns = exporter.columnsFor
      ? await exporter.columnsFor(principal)
      : exporter.columns;
    // Dates as the reader's local time: the zone asked for, the user's own
    // (as saved now), else the server's.
    const timeZone = readerZone(
      principal,
      this.config.get('APP_TIMEZONE', { infer: true }),
      job.data.timezone,
    );
    await this.writeFile(
      key,
      job.data.format,
      columns,
      async (write) => {
        for await (const batch of exporter.batches(principal, filters)) {
          // Field-level permissions: only the fields this principal may read.
          await write(
            await this.access.redactAll(
              principal,
              action,
              exporter.subject,
              batch,
            ),
          );
          rows += batch.length;
          await job.updateProgress({ processed: rows });
        }
      },
      timeZone,
    );
    const url = await this.disk.signedUrl(key, {
      expiresIn: TRANSFER_LINK_TTL,
    });
    this.realtime.toPrincipal(principal, 'data.export-ready', {
      id: job.id,
      name: job.data.name,
      rows,
      url,
    });
    await this.audit.record(principal, {
      action: 'data.exported',
      targetType: 'data-transfer',
      targetId: job.id,
      details: { name: job.data.name, format: job.data.format, rows },
    });
    this.logger.log('Export done', { id: job.id, name: job.data.name, rows });
    return { kind: 'export', key, rows };
  }

  private async import(
    job: Job<Extract<TransferJob, { kind: 'import' }>>,
    principal: Principal,
  ): Promise<TransferResult> {
    const importer = this.registry.importer(job.data.name)!;
    // Read once: every row of a file is checked against the same fields.
    const schema = importer.schemaFor
      ? await importer.schemaFor(principal)
      : importer.schema;
    // The file's date columns, as the template names them: their Excel
    // date cells are read as days.
    const columns = importer.templateColumns
      ? await importer.templateColumns(principal)
      : columnsOf(importer.schema);
    const dateColumns = new Set(
      columns.filter((column) => column.type === 'date').map((c) => c.name),
    );
    // An empty cell of an optional column that can't hold an empty value
    // (a number, a text with a minimum length) is no value: the file an
    // export wrote imports as it is.
    const blankIsAbsent = new Set(
      columns
        .filter(
          (column) =>
            !column.required &&
            (column.type !== 'text' || (column.min ?? 0) > 0),
        )
        .map((column) => column.name),
    );
    const action = importer.action ?? 'create';
    const errors: ImportRowError[] = [];
    let rows = 0;
    let imported = 0;
    const refuse = (refused: ImportRowError[]) => {
      errors.push(...refused);
      if (errors.length > MAX_ERRORS) {
        throw new Error(
          `More than ${MAX_ERRORS} errors: check the file's format and columns.`,
        );
      }
    };
    // The upload was stored under the tenant's prefix: a payload naming
    // another key (another tenant's file) is refused, neither read nor deleted.
    if (
      !job.data.tenantId ||
      !isTenantFileKey(job.data.tenantId, job.data.key)
    ) {
      throw new Error('The upload is not one of this tenant’s files.');
    }
    try {
      const { body } = await this.disk.get(job.data.key);
      for await (const { row, record } of readRecords(job.data.format, body, {
        dateColumns,
      })) {
        rows = row;
        if (row === 1 && importer.refusedColumns) {
          // Once, on the file's columns: one no row could pass (a custom
          // field that no longer exists) fails the import with one message
          // instead of refusing every row.
          const refused = await importer.refusedColumns(
            principal,
            Object.keys(record),
          );
          if (refused.length) {
            throw new Error(
              `Unknown columns: ${refused.join(', ')}. Check the template.`,
            );
          }
        }
        // Each row as one POST of the feature: its schema, the field-level
        // permissions, then the same service call (its 4xx refuses the row).
        for (const name of blankIsAbsent) {
          if (record[name] === '') delete record[name];
        }
        const parsed = schema.safeParse(record);
        if (!parsed.success) {
          refuse(
            parsed.error.issues.map((issue) => ({
              row,
              path: issue.path.join('.'),
              message: issue.message,
            })),
          );
        } else {
          const forbidden = await this.access.forbiddenFields(
            principal,
            action,
            importer.subject,
            valuesSet(parsed.data as Record<string, unknown>),
          );
          if (forbidden.length) {
            refuse(
              forbidden.map((field) => ({
                row,
                path: field,
                message: 'You may not set this field.',
              })),
            );
          } else if (job.data.dryRun) {
            imported++;
          } else {
            try {
              await importer.write(principal, parsed.data);
              imported++;
            } catch (error) {
              const refused = refusal(error, row);
              if (!refused) throw error;
              refuse(refused);
            }
          }
        }
        if (row % PROGRESS_EVERY === 0) {
          await job.updateProgress({
            processed: rows,
            imported,
            failed: errors.length,
          });
        }
      }
    } finally {
      // The upload was only a means: it goes, whatever happened.
      await this.disk.delete(job.data.key).catch(() => undefined);
    }
    let errorsKey: string | undefined;
    if (errors.length) {
      errorsKey = jobFileKey(job.data, `${job.id}-errors.csv`);
      await this.writeFile(
        errorsKey,
        'csv',
        [{ key: 'row' }, { key: 'path', header: 'field' }, { key: 'message' }],
        (write) => write(errors as unknown as Record<string, unknown>[]),
      );
    }
    const failedRows = new Set(errors.map((error) => error.row)).size;
    const result: TransferResult = {
      kind: 'import',
      rows,
      imported,
      failed: failedRows,
      dryRun: job.data.dryRun,
      errorsKey,
    };
    this.realtime.toPrincipal(principal, 'data.import-finished', {
      id: job.id,
      name: job.data.name,
      rows,
      imported,
      failed: failedRows,
    });
    await this.audit.record(principal, {
      action: job.data.dryRun ? 'data.import-checked' : 'data.imported',
      targetType: 'data-transfer',
      targetId: job.id,
      details: {
        name: job.data.name,
        format: job.data.format,
        rows,
        imported,
        failed: failedRows,
      },
    });
    return result;
  }

  /**
   * Streams a file onto the disk: `produce` writes its rows while the upload
   * runs. A failure on either side fails the whole (no unhandled rejection),
   * and the stream is destroyed, so a multipart upload is aborted rather than
   * left open.
   */
  private async writeFile(
    key: string,
    format: TransferFormat,
    columns: readonly TransferColumn[],
    produce: (
      write: (rows: Record<string, unknown>[]) => Promise<void>,
    ) => Promise<void>,
    timeZone?: string,
  ) {
    const writer = createWriter(format, columns, timeZone);
    const stored = this.disk.put(key, writer.output, {
      contentType: CONTENT_TYPES[format],
    });
    try {
      await Promise.all([
        (async () => {
          await produce(writer.write);
          await writer.end();
        })(),
        stored,
      ]);
    } catch (error) {
      writer.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
