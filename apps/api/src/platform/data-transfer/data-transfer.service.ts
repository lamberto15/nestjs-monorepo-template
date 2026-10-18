import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import { StorageDisk } from '@nestjs/storage';
import type { Job, Queue } from 'bullmq';
import type { CoreEnv } from '../../core/config/core.env.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  currentTenantId,
  requireTenantId,
  TenantScopeMissingError,
} from '../../core/tenancy/tenant-scope.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  assertRequestPrincipal,
  principalKey,
  type Principal,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { JobIndex, type JobPage } from '../queues/job-index.js';
import { accountFileKey, tenantFileKey } from '../storage/storage.config.js';
import { DataTransferRegistry } from './data-transfer.registry.js';
import {
  TRANSFER_FORMATS,
  type DataExporter,
  type DataImporter,
  type ImportColumn,
  type TransferFormat,
  type TransferJob,
  type TransferResult,
} from './data-transfer.types.js';
import {
  CONTENT_TYPES,
  createTemplate,
  type TemplateGuide,
} from './formats.js';
import { columnsOf } from './import-columns.js';

/** A column's example as the guide's cell shows it. */
const shown = (example: unknown) =>
  example === undefined || example === null
    ? ''
    : Array.isArray(example)
      ? example.join(', ')
      : typeof example === 'object'
        ? JSON.stringify(example)
        : String(example as string | number | boolean);

/** The catalog's keys of the template guide (`transfer.template.*`), typed. */
type TemplateKey = Extract<
  Parameters<I18nService['t']>[0],
  `transfer.template.${string}`
>;
type TemplateText = TemplateKey extends `transfer.template.${infer Key}`
  ? Key
  : never;

/**
 * The time zone of a file's dates: the one asked for, else the user's own,
 * else the server's.
 */
export const readerZone = (
  principal: Principal,
  fallback: string,
  asked?: string,
) =>
  asked ?? (principal.kind === 'user' ? principal.timezone : null) ?? fallback;

/** Where a tenant's transfer files live on the private disk (`tenants/<id>/transfers/…`). */
export const transferKey = (tenantId: string, name: string) =>
  tenantFileKey(tenantId, `transfers/${name}`);

/**
 * Where a transfer's files go: its tenant's (`tenants/<id>/transfers/…`),
 * or, for an account export (no tenant), the person's own
 * (`accounts/<user id>/transfers/…`).
 */
export const jobFileKey = (job: TransferJob, name: string) =>
  job.tenantId
    ? transferKey(job.tenantId, name)
    : accountFileKey(job.principal.id, `transfers/${name}`);

/** The tenant a principal acts in, or TenantScopeMissingError (403 tenant_required) without one. */
export const principalTenant = (principal: RequestPrincipal) => {
  if (!principal.tenantId) {
    throw new TenantScopeMissingError('A transfer needs a tenant.');
  }
  return principal.tenantId;
};

/** The tenant a transfer runs in: the principal's, which is the request's. */
const transferTenant = (principal: RequestPrincipal) => {
  const tenantId = requireTenantId('A transfer');
  if (principal.tenantId !== tenantId) {
    throw new Error("A transfer is queued in its principal's tenant only.");
  }
  return tenantId;
};

/** The queue of exports and imports. */
export const DATA_TRANSFERS = 'data-transfers';

/** The JobIndex list of a principal's transfers, or of one kind of them. */
const transferList = (kind?: TransferJob['kind']) =>
  kind ? `${DATA_TRANSFERS}:${kind}` : DATA_TRANSFERS;

/** A transfer as GET /data/transfers/{id} (and each item of the list) tells it. */
export interface TransferStatus {
  id: string;
  kind: TransferJob['kind'];
  name: string;
  format: TransferFormat;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: Record<string, number>;
  result?: {
    rows: number;
    url?: string;
    imported?: number;
    failed?: number;
    dryRun?: boolean;
    errorsUrl?: string;
  };
  error?: string;
}

/** How long a download link works. */
export const TRANSFER_LINK_TTL = '30m';

/**
 * Starts exports and imports as queue jobs (a worker does the work), and
 * reports them to the principal who started them, and to nobody else.
 */
@Injectable()
export class DataTransferService {
  constructor(
    @InjectQueue(DATA_TRANSFERS)
    private readonly queue: Queue<TransferJob, TransferResult>,
    private readonly registry: DataTransferRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly disk: StorageDisk,
    private readonly config: ConfigService<CoreEnv, true>,
    private readonly i18n: I18nService,
    private readonly tenancy: Tenancy,
    private readonly jobs: JobIndex,
  ) {}

  /** What the caller may export and import. */
  async catalog(principal: Principal) {
    const exports = [];
    for (const exporter of this.registry.allExporters()) {
      if (await this.mayExport(principal, exporter)) {
        exports.push({
          name: exporter.name,
          columns: (exporter.columnsFor
            ? await exporter.columnsFor(principal)
            : exporter.columns
          ).map((c) => c.header ?? c.key),
          formats: TRANSFER_FORMATS,
        });
      }
    }
    const imports = [];
    for (const importer of this.registry.allImporters()) {
      if (
        await this.access.can(
          principal,
          importer.action ?? 'create',
          importer.subject,
        )
      ) {
        imports.push({
          name: importer.name,
          formats: TRANSFER_FORMATS,
          columns: await this.importColumns(principal, importer),
          template: `/v1/data/imports/${importer.name}/template`,
        });
      }
    }
    return { exports, imports };
  }

  async startExport(
    principal: RequestPrincipal,
    input: {
      name: string;
      format: TransferFormat;
      filters?: Record<string, unknown>;
      timezone?: string;
      /** Handed back to `registry.onFinished` listeners: who asked for it in code (`report:<id>`). */
      tag?: string;
      /** The transfer's id, when the caller chose it beforehand (a UUID); default: a new one. */
      id?: string;
      /** Added to the `data.export-started` audit entry (`{ report, trigger: 'schedule' }`). */
      details?: Record<string, unknown>;
    },
  ) {
    const exporter = this.registry.exporter(input.name);
    if (!exporter) {
      throw new NotFoundException(`Nothing to export named "${input.name}".`);
    }
    if (!(await this.mayExport(principal, exporter))) {
      throw new ForbiddenException();
    }
    // The export's filters are checked now: a typo is a 400, not a failed job.
    const parsed = exporter.filters?.safeParse(input.filters ?? {});
    if (parsed && !parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The filters are invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: ['filters', ...issue.path].join('.'),
          message: issue.message,
        })),
      });
    }
    if (parsed) {
      // Field-level: which rows an export holds would tell a hidden field's values.
      await this.access.assertQueryFields(
        principal,
        exporter.subject,
        parsed.data as ListQuery,
        // Among the rows the export reaches (the job's sqlFilter()).
        { reach: exporter.action ?? 'read' },
      );
    }
    // The job keeps the raw filters: it travels as JSON, so parsed values
    // (dates) would arrive as strings. The worker parses them again.
    return this.enqueue(
      principal,
      {
        kind: 'export',
        // An account export is the person's, across their tenants: queued
        // in none (docs/tenancy.md), so a user with no tenant has one too.
        tenantId:
          exporter.scope === 'account' ? null : transferTenant(principal),
        name: exporter.name,
        format: input.format,
        filters: input.filters ?? {},
        timezone: input.timezone,
        ...(input.tag && { tag: input.tag }),
        principal,
      },
      { id: input.id, details: input.details },
    );
  }

  async startImport(
    principal: RequestPrincipal,
    input: {
      name: string;
      key: string;
      format: TransferFormat;
      dryRun: boolean;
    },
  ) {
    const importer = this.registry.importer(input.name);
    if (
      !importer ||
      !(await this.access.can(
        principal,
        importer.action ?? 'create',
        importer.subject,
      ))
    ) {
      await this.disk.delete(input.key);
      if (!importer) {
        throw new NotFoundException(`Nothing to import named "${input.name}".`);
      }
      throw new ForbiddenException();
    }
    return this.enqueue(principal, {
      kind: 'import',
      tenantId: transferTenant(principal),
      ...input,
      principal,
    });
  }

  /** Whether the principal may run this export: its own say (`allowed`), else the permission. */
  mayExport(principal: Principal, exporter: DataExporter) {
    return exporter.allowed
      ? exporter.allowed(principal)
      : this.access.can(principal, exporter.action ?? 'read', exporter.subject);
  }

  /**
   * The columns of an import this principal may fill: the importer's own
   * (read from its schema), less the fields they may not set.
   */
  private async importColumns(
    principal: Principal,
    importer: DataImporter,
  ): Promise<ImportColumn[]> {
    const columns = importer.templateColumns
      ? await importer.templateColumns(principal)
      : columnsOf(importer.schema);
    const field = (column: ImportColumn) => column.name.split('.')[0]!;
    const forbidden = await this.access.forbiddenFields(
      principal,
      importer.action ?? 'create',
      importer.subject,
      Object.fromEntries(columns.map((column) => [field(column), true])),
    );
    return columns.filter((column) => !forbidden.includes(field(column)));
  }

  /**
   * A file to fill for an import: its columns, an example row, and (Excel)
   * a guide in the reader's language. Two rows: built in the request.
   */
  async template(
    principal: Principal,
    name: string,
    { format, timezone }: { format: TransferFormat; timezone?: string },
  ) {
    const importer = this.registry.importer(name);
    if (
      !importer ||
      !(await this.access.can(
        principal,
        importer.action ?? 'create',
        importer.subject,
      ))
    ) {
      throw new NotFoundException(`Nothing to import named "${name}".`);
    }
    const timeZone = readerZone(
      principal,
      this.config.get('APP_TIMEZONE', { infer: true }),
      timezone,
    );
    const file = await createTemplate(
      format,
      await this.importColumns(principal, importer),
      timeZone,
      this.guide(timeZone),
    );
    return {
      file,
      type: CONTENT_TYPES[format],
      filename: `${importer.name}-template.${format}`,
    };
  }

  /** The texts of a template's guide, in the request's language (t's default). */
  private guide(zone: string): TemplateGuide {
    const t = (key: TemplateText, args: Record<string, unknown> = {}) =>
      this.i18n.t(`transfer.template.${key}` as TemplateKey, { args });
    const format = (column: ImportColumn) => {
      const { min, max } = column;
      const options = column.options?.join(', ');
      switch (column.type) {
        case 'text':
          if (options) return t('format.options', { options });
          if (min !== undefined && max !== undefined) {
            return t('format.textRange', { min, max });
          }
          if (max !== undefined) return t('format.textMax', { max });
          return min !== undefined ? t('format.textMin', { min }) : '';
        case 'number':
          if (min !== undefined && max !== undefined) {
            return t('format.numberRange', { min, max });
          }
          if (min !== undefined) return t('format.numberMin', { min });
          if (max !== undefined) return t('format.numberMax', { max });
          return t('format.number');
        case 'list':
          return options
            ? t('format.listOptions', { options })
            : t('format.list');
        case 'datetime':
          return t('format.datetime', { zone });
        default:
          return t(`format.${column.type}`);
      }
    };
    return {
      sheets: { data: t('sheets.data'), columns: t('sheets.columns') },
      headers: (
        [
          'column',
          'required',
          'type',
          'format',
          'example',
          'description',
        ] as const
      ).map((key) => t(`headers.${key}`)),
      line: (column) => [
        column.type === 'datetime' ? `${column.name} (${zone})` : column.name,
        t(column.required ? 'yes' : 'no'),
        t(`types.${column.type}`),
        format(column),
        shown(column.example),
        column.description ?? '',
      ],
      note: t('note'),
    };
  }

  /**
   * A transfer of this principal in this tenant: its state, progress and
   * result (with links). Another tenant's transfer is a 404, even the same
   * person's (a user who belongs to both): the job names its tenant. An
   * account export (no tenant) is its user's in any tenant, or none.
   */
  async status(principal: Principal, id: string) {
    const job = await this.queue.getJob(id);
    if (!job || !this.isOwn(principal, job)) {
      throw new NotFoundException(`Transfer ${id} not found.`);
    }
    return this.view(job);
  }

  /**
   * The transfers this principal started in this tenant (exports, imports,
   * or one `kind`), newest first, by cursor (the last id of the previous
   * page), each as `status()` tells it. Those BullMQ still keeps (7 days
   * after they end); an account export (no tenant) is not among them.
   */
  async list(
    principal: RequestPrincipal,
    query: { kind?: TransferJob['kind']; limit: number; cursor?: string },
  ): Promise<JobPage<TransferStatus>> {
    return this.jobs.page(
      transferList(query.kind),
      principalTenant(principal),
      principal,
      query,
      async (id) => {
        const job = await this.queue.getJob(id);
        return job && job.data.tenantId !== null && this.isOwn(principal, job)
          ? this.view(job)
          : null;
      },
    );
  }

  /**
   * Whether the principal may see this transfer: theirs, started in this
   * tenant. Another tenant's transfer is unseen, even the same person's (a
   * user who belongs to both): the job names its tenant. An account export
   * (no tenant) is its user's in any tenant, or none.
   */
  private isOwn(principal: Principal, job: Job<TransferJob, TransferResult>) {
    return (
      (job.data.tenantId === null || job.data.tenantId === currentTenantId()) &&
      principalKey(job.data.principal) === principalKey(principal) &&
      // An account export (no tenant) is the person's alone: never shown,
      // nor its link given, to an administrator acting as them.
      !(
        job.data.tenantId === null &&
        principal.kind === 'user' &&
        !!principal.impersonator
      )
    );
  }

  /** A transfer's state, progress and result (with links). */
  private async view(
    read: Job<TransferJob, TransferResult>,
  ): Promise<TransferStatus> {
    const id = read.id!;
    let job = read;
    const state = await job.getState();
    if (
      (state === 'completed' && job.returnvalue == null) ||
      (state === 'failed' && job.failedReason == null)
    ) {
      // It finished between the two reads: read it again, with its result
      // or its reason (else a refused file read as an internal failure).
      job = (await this.queue.getJob(id)) ?? job;
    }
    const base = {
      id,
      kind: job.data.kind,
      name: job.data.name,
      format: job.data.format,
      status:
        state === 'completed'
          ? ('completed' as const)
          : state === 'failed'
            ? ('failed' as const)
            : state === 'active'
              ? ('running' as const)
              : ('queued' as const),
      progress:
        typeof job.progress === 'object'
          ? (job.progress as Record<string, number>)
          : { processed: 0 },
    };
    if (state === 'failed') {
      // Only messages written for people (a bad file); never internal error text.
      return { ...base, error: publicReason(job.failedReason) };
    }
    if (state !== 'completed') {
      return base;
    }
    const result = job.returnvalue;
    const link = (key: string) =>
      this.disk.signedUrl(key, { expiresIn: TRANSFER_LINK_TTL });
    return result.kind === 'export'
      ? { ...base, result: { rows: result.rows, url: await link(result.key) } }
      : {
          ...base,
          result: {
            rows: result.rows,
            imported: result.imported,
            failed: result.failed,
            dryRun: result.dryRun,
            ...(result.errorsKey && {
              errorsUrl: await link(result.errorsKey),
            }),
          },
        };
  }

  private async enqueue(
    principal: Principal,
    job: TransferJob,
    { id, details }: { id?: string; details?: Record<string, unknown> } = {},
  ) {
    assertRequestPrincipal(job.principal, 'A queued transfer');
    if (job.tenantId === null) {
      // An account export: a user's, and an export only.
      if (job.kind !== 'export' || job.principal.kind !== 'user') {
        throw new Error("Only a user's account export is queued in no tenant.");
      }
    } else if (
      job.tenantId !== requireTenantId('A transfer') ||
      job.principal.tenantId !== job.tenantId
    ) {
      // A bug, never a caller's choice: the job would run in another tenant.
      throw new Error("A transfer is queued in its principal's tenant only.");
    }
    const jobId = id ?? randomUUID();
    if (job.tenantId !== null) {
      // Listed for its principal (GET /data/transfers) before it is queued.
      await this.jobs.add(
        [transferList(), transferList(job.kind)],
        job.tenantId,
        job.principal,
        jobId,
      );
    }
    const added = await this.queue.add(job.kind, job, {
      jobId,
      // A transfer is not retried blindly: an import could write a batch twice.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
    });
    const started = () =>
      this.audit.record(principal, {
        action: `data.${job.kind}-started`,
        targetType: 'data-transfer',
        targetId: added.id!,
        details: {
          name: job.name,
          format: job.format,
          ...(job.kind === 'import' && { dryRun: job.dryRun }),
          ...details,
        },
      });
    // An account export's entry is the account's, in no tenant's log.
    await (job.tenantId === null ? this.tenancy.none(started) : started());
    return { id: added.id!, status: 'queued' as const };
  }
}

/** Reasons a person can act on; anything else (a database error) stays in the logs. */
const PUBLIC_REASONS = [
  /^The account that started this transfer is no longer active\.$/,
  /^More than \d+ errors: check the file's format and columns\.$/,
  /^Unknown columns: .*\. Check the template\.$/,
  /^A JSON import is an array of objects\.$/,
  /^The spreadsheet is too large/,
  /^Unexpected token|^Invalid|is not valid JSON/,
];
const publicReason = (reason: string | undefined) =>
  reason && PUBLIC_REASONS.some((pattern) => pattern.test(reason))
    ? reason
    : 'The transfer failed. Check the file, or ask an administrator (the transfer id is in the logs).';
