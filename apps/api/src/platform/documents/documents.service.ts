import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk } from '@nestjs/storage';
import { type Queue, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
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
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  assertRequestPrincipal,
  type Principal,
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import {
  ANONYMIZED_UPLOADER,
  AttachmentsService,
} from '../attachments/attachments.service.js';
import { PeopleService } from '../people/people.service.js';
import type { CanFlag } from '../records/record-can.js';
import type { PlatformEnv } from '../platform.env.js';
import { Realtime } from '../realtime/realtime.service.js';
import { tenantFileKey } from '../storage/storage.config.js';
import { DocumentTemplates } from './document-templates.js';
import { DOCUMENT_LIST } from './document.list.js';
import type {
  DocumentTemplate,
  DocumentView,
  RecordDocumentView,
} from './document.schemas.js';
import { DocumentsRegistry } from './documents.registry.js';
import {
  type DocumentRow,
  type DocumentStatus,
  documents,
} from './documents.tables.js';
import { PdfRejectedError, PdfRenderer } from './pdf-renderer.js';

/** The queue of documents to render. */
export const DOCUMENTS = 'documents';

/**
 * What a queued render carries: the document, who asked (checked again
 * when it runs), and the tenant both are in (TenantEnvelope,
 * docs/tenancy.md: the worker renders in it, and nowhere else).
 */
export interface DocumentJob extends TenantEnvelope {
  readonly tenantId: string;
  id: string;
  principal: RequestPrincipal;
}

/** Why a document failed, as people read it (never internal error text). */
export const DOCUMENT_ERRORS = {
  principalGone:
    'The account that asked for this document is no longer active.',
  recordGone: 'The record no longer exists, or you may no longer read it.',
  rejected:
    'The PDF service refused this document; ask an administrator (the document id is in the logs).',
  unavailable:
    'The PDF service failed or did not answer in time; ask for the document again later.',
} as const;

/**
 * Documents issued for records: a feature's DocumentSource gives the
 * template and its values, a queue job renders the PDF (Gotenberg, on the
 * workers), and the transaction that completes the job adds it to the
 * record as a locked attachment (otherwise the attachment sweep would find
 * a file with no row, or a row with no file). Issued documents never
 * change; asking again issues a new one. The requester hears
 * `document.ready` (or `document.failed`) over realtime; anyone who may
 * read the record follows it at GET /v1/documents/{id}.
 */
@Injectable()
export class DocumentsService implements PersonalDataSource {
  readonly name = 'documents';
  private readonly logger = new Logger('Documents');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    @InjectQueue(DOCUMENTS) private readonly queue: Queue<DocumentJob>,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: DocumentsRegistry,
    private readonly attachments: AttachmentsService,
    private readonly templates: DocumentTemplates,
    private readonly renderer: PdfRenderer,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly realtime: Realtime,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    private readonly people: PeopleService,
    personalData: PersonalDataRegistry,
  ) {
    personalData.register(this);
  }

  /**
   * Asks for a document of a record: checked now (the record readable, the
   * source's `canIssue`), rendered by a worker. 503 `documents_unavailable`
   * while GOTENBERG_URL is unset; 409 `document_pending` while the same
   * requester's document of the record, in the same language, is queued or
   * rendering (one at a time: the partial unique index decides a race).
   */
  async request(
    principal: RequestPrincipal,
    request: {
      source: string;
      recordId: string;
      locale: string;
      timezone?: string | null;
      ip?: string;
    },
  ) {
    if (!this.renderer.enabled) {
      throw new ServiceUnavailableException({
        code: 'documents_unavailable',
        message: 'PDF documents are not set up on this server.',
      });
    }
    const source = this.registry.get(request.source);
    if (!source) {
      throw new Error(`No document source named "${request.source}".`);
    }
    const record = { subject: source.subject, recordId: request.recordId };
    await this.attachments.assertCanRead(principal, record);
    // The check a record's `can.issue` repeats (mayIssue()).
    if (!(await source.canIssue(principal, request.recordId))) {
      throw new ForbiddenException(
        `You may not issue this document for ${source.subject} ${request.recordId}.`,
      );
    }
    assertRequestPrincipal(principal, 'A queued document');
    const tenantId = requireTenantId('A document');
    if (principal.tenantId !== tenantId) {
      // A bug, never a caller's choice: the render would run in another tenant.
      throw new Error("A document is rendered in its requester's tenant only.");
    }
    const timezone =
      request.timezone ??
      (principal.kind === 'user' ? principal.timezone : null) ??
      this.config.get('APP_TIMEZONE', { infer: true });
    const pending = {
      source: source.name,
      recordId: request.recordId,
      requestedBy: principalKey(principal),
      locale: request.locale,
    };
    const row = await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .insert(documents)
        .values({
          ...pending,
          subject: source.subject,
          timezone,
          status: 'queued',
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'document.requested',
          targetType: 'document',
          targetId: row!.id,
          details: { source: source.name, ...record, locale: request.locale },
          ip: request.ip,
        },
        tx,
      );
      return row!;
    }).catch(async (error: unknown) => {
      const code =
        (error as { code?: string })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      if (code !== '23505') throw error;
      const [open] = await this.db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.source, pending.source),
            eq(documents.recordId, pending.recordId),
            eq(documents.requestedBy, pending.requestedBy),
            eq(documents.locale, pending.locale),
            inArray(documents.status, OPEN),
          ),
        );
      throw new ConflictException({
        code: 'document_pending',
        message:
          'This document is already being rendered for you: wait for it (GET /v1/documents/{id}).',
        id: open?.id,
      });
    });
    try {
      await this.queue.add(
        source.name,
        { id: row.id, principal, tenantId },
        {
          // The document's id: a job is queued once per document.
          jobId: row.id,
          attempts: this.config.get('DOCUMENTS_RENDER_ATTEMPTS', {
            infer: true,
          }),
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
    } catch (error) {
      await this.fail(
        { id: row.id, principal, tenantId },
        DOCUMENT_ERRORS.unavailable,
      );
      throw error;
    }
    return { id: row.id, status: 'queued' as const };
  }

  /**
   * What a record's `can.issue` (`?include=can`) says, for a record the
   * principal may read (the caller checked: the policy's `read`, as the
   * route's assertCanRead does): the checks request() makes after that,
   * without asking. False while documents are off (no GOTENBERG_URL: the
   * route's 503), for the system principal, and where the source's
   * `canIssue` says no (the route's 403).
   */
  async mayIssue(
    principal: Principal,
    sourceName: string,
    recordId: string,
  ): Promise<boolean> {
    const source = this.registry.get(sourceName);
    if (!this.renderer.enabled || !source || principal.kind === 'system') {
      return false;
    }
    return source.canIssue(principal, recordId);
  }

  /**
   * A record's `can.issue` (`?include=can`, record-can.ts): what POST
   * …/{id}/pdf checks, in its order: the record readable (the policy's
   * `read` on the row, as the route's assertCanRead asks it; never one in
   * the recycle bin, which the route can't find), then mayIssue().
   */
  issueFlag(principal: Principal, sourceName: string): CanFlag {
    return async (row, check) =>
      row.deletedAt == null &&
      this.renderer.enabled &&
      (await check('read')) &&
      (await this.mayIssue(principal, sourceName, row.id));
  }

  /**
   * The templates a subject's documents are issued from (GET
   * /v1/lists/{subject}, `documentTemplates`): each DocumentSource of the
   * subject, in each language the server answers in (LOCALES; a
   * `<template>.<locale>.html` is used where there is one, else the
   * template with translated labels). Empty while documents are off.
   */
  templatesOf(subject: string): DocumentTemplate[] {
    if (!this.renderer.enabled) {
      return [];
    }
    const languages = this.config.get('LOCALES', { infer: true });
    return this.registry
      .forSubject(subject)
      .flatMap((source) =>
        languages.map((language) => ({ id: source.name, language })),
      );
  }

  /**
   * A page of a record's documents, newest first: in progress (queued,
   * rendering), issued and failed, each with who asked for it (named in one
   * query for the page, PeopleService.names()). A 404 unless the principal
   * may read the record, as its attachments list (row-level security keeps
   * it to the tenant).
   */
  async list(
    principal: Principal,
    record: { subject: string; recordId: string },
    query: ListQuery,
  ) {
    await this.attachments.assertCanRead(principal, record);
    const where = and(
      eq(documents.subject, record.subject),
      eq(documents.recordId, record.recordId),
      DOCUMENT_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(documents)
        .where(and(where, afterCursor(documents.id, query)))
        .orderBy(...pageOrder(documents.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, documents, where, query),
    ]);
    const page = toPage(rows, query, total);
    const names = await this.people.names(
      page.items.map((row) => row.requestedBy),
    );
    return {
      ...page,
      items: page.items.map((row) => listed(row, names)),
    };
  }

  /**
   * A document of a record the principal may read, or a 404: every field it
   * shows too (field-level permissions), as for its attachment.
   */
  async status(principal: Principal, id: string): Promise<DocumentView> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, id));
    if (!row) {
      throw new NotFoundException(`Document ${id} not found.`);
    }
    try {
      await this.attachments.assertCanRead(principal, row, row.fields);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(`Document ${id} not found.`);
      }
      throw error;
    }
    return view(row);
  }

  /** Whether the tenant's erase has started (`tenants.deletion_started_at`). */
  private async tenantBeingErased(tenantId: string) {
    const [tenant] = await this.db
      .select({ startedAt: tenants.deletionStartedAt })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return !tenant || tenant.startedAt !== null;
  }

  /**
   * On the worker: renders the document and issues it.
   *
   * Each run claims the document with a token of its own (queued or
   * rendering → rendering, its token), writes its PDF under its own key
   * (`tenants/<tenant>/documents/<id>/<token>.pdf`), and completes the document only while
   * it still holds the claim. A run started twice (a stalled job picked up
   * again while the first still runs) thus issues one PDF: the later claim
   * wins, the other run finds its claim gone, deletes its own file and
   * stops. A document already issued is left as it is; a failed one isn't
   * rendered again. Errors a retry can't fix are UnrecoverableError; the
   * others are retried (DOCUMENTS_RENDER_ATTEMPTS), then the document fails.
   */
  async issue(
    job: DocumentJob,
    principal: RequestPrincipal | null,
    attempt: { final: boolean },
  ): Promise<DocumentView> {
    const token = randomUUID();
    const [row] = await this.db
      .update(documents)
      .set({ status: 'rendering', runToken: token })
      .where(and(eq(documents.id, job.id), inArray(documents.status, OPEN)))
      .returning();
    if (!row) {
      const [now] = await this.db
        .select()
        .from(documents)
        .where(eq(documents.id, job.id));
      if (now?.status === 'completed') {
        return view(now); // issued by an earlier run: nothing to do
      }
      throw new UnrecoverableError(
        `Document ${job.id} is ${now ? now.status : 'gone'}: not rendered.`,
      );
    }
    const key = documentKey(row.tenantId, row.id, token);
    let written = false;
    try {
      if (!principal) {
        throw new DocumentFailure(DOCUMENT_ERRORS.principalGone);
      }
      const source = this.registry.get(row.source);
      if (!source) {
        throw new UnrecoverableError(`No document source "${row.source}".`);
      }
      const issuedAt = new Date();
      let content;
      try {
        content = await source.content(principal, row.recordId, {
          locale: row.locale,
          timezone: row.timezone,
          issuedAt,
        });
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw new DocumentFailure(DOCUMENT_ERRORS.recordGone);
        }
        throw error;
      }
      const html = await this.templates.render(
        content.template,
        content.context,
        { locale: row.locale, title: content.title },
      );
      const pdf = await this.renderer.render(html, { trace: row.id });
      // A tenant being erased gets no new file: its files' sweep may have
      // run already (TenantDeletionJob claims the tenant before it removes
      // its jobs and files; a render that passed here is still running,
      // which postpones the erase).
      if (await this.tenantBeingErased(row.tenantId)) {
        throw new UnrecoverableError(
          `Document ${row.id}: its tenant is being erased, not rendered.`,
        );
      }
      written = true;
      await this.disk.put(key, pdf, { contentType: 'application/pdf' });
      const fields = [...new Set(content.fields)].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const issued = await inTransaction(this.txHost, async (tx) => {
        const attachment = await this.attachments.attachStored(
          principal,
          { subject: row.subject, recordId: row.recordId },
          {
            key,
            name: `${content.fileName}.pdf`,
            size: pdf.length,
            contentType: 'application/pdf',
          },
          { locked: true, fields },
        );
        const [issued] = await tx
          .update(documents)
          .set({
            status: 'completed',
            attachmentId: attachment.id,
            fields,
            issuedAt,
            error: null,
          })
          .where(
            and(
              eq(documents.id, row.id),
              eq(documents.status, 'rendering'),
              eq(documents.runToken, token),
            ),
          )
          .returning();
        if (!issued) {
          throw new ClaimLost(row.id);
        }
        await this.audit.record(
          principal,
          {
            action: 'document.issued',
            targetType: 'document',
            targetId: row.id,
            details: {
              source: row.source,
              subject: row.subject,
              recordId: row.recordId,
              attachmentId: attachment.id,
              fields,
              size: pdf.length,
            },
          },
          tx,
        );
        return issued;
      });
      written = false; // issued: the file is the attachment's now
      // The record's open pages: its attachments changed (an issued document is one).
      this.attachments.changed(
        principal,
        { subject: row.subject, recordId: row.recordId },
        issued.attachmentId!,
        'added',
      );
      // After the commit: a client never hears of a document that rolled back.
      this.realtime.toPrincipal(principal, 'document.ready', {
        id: issued.id,
        subject: issued.subject,
        recordId: issued.recordId,
        attachmentId: issued.attachmentId,
      });
      this.logger.log('Document issued', {
        id: issued.id,
        source: issued.source,
        size: pdf.length,
      });
      return view(issued);
    } catch (error) {
      // This run's own file, never another's: nothing points at it.
      if (written) {
        await this.disk.delete(key).catch(() => undefined);
      }
      if (error instanceof ClaimLost) {
        this.logger.warn(
          'A document render lost its claim: another run holds it',
          {
            id: row.id,
          },
        );
        throw new DocumentClaimLost(error.message);
      }
      const final =
        attempt.final ||
        error instanceof UnrecoverableError ||
        error instanceof DocumentFailure;
      this.logger.warn(
        final ? 'A document failed' : 'A document render failed: retrying',
        { id: row.id, error: String(error) },
      );
      if (final) {
        await this.fail(
          job,
          publicReason(error),
          principal ?? undefined,
          token,
        );
      }
      throw error instanceof DocumentFailure
        ? new UnrecoverableError(error.message)
        : error;
    }
  }

  /**
   * A document that failed for good: its state and its audit entry in one
   * transaction, then the requester told. Idempotent: only a queued or
   * rendering document fails (with `runToken`, only while that run holds
   * it), so a second call (the worker's failed event after `issue()`'s own)
   * changes, audits and tells nothing. Deletes no file: each run deletes
   * its own, and an issued document's is its attachment.
   */
  async fail(
    job: DocumentJob,
    reason: string,
    principal: Pick<Principal, 'kind' | 'id'> = job.principal,
    runToken?: string,
  ) {
    const failed = await inTransaction(this.txHost, async (tx) => {
      const [failed] = await tx
        .update(documents)
        .set({ status: 'failed', error: reason })
        .where(
          and(
            eq(documents.id, job.id),
            inArray(documents.status, OPEN),
            runToken ? eq(documents.runToken, runToken) : undefined,
          ),
        )
        .returning();
      if (failed) {
        await this.audit.record(
          principal as Principal,
          {
            action: 'document.failed',
            targetType: 'document',
            targetId: failed.id,
            details: {
              source: failed.source,
              subject: failed.subject,
              recordId: failed.recordId,
              error: reason,
            },
          },
          tx,
        );
      }
      return failed;
    });
    if (!failed) {
      return; // issued, failed already, or held by another run
    }
    this.realtime.toPrincipal(principal, 'document.failed', {
      id: failed.id,
      subject: failed.subject,
      recordId: failed.recordId,
      error: reason,
    });
  }

  /** The user's requests, for their data export. */
  async *rows(user: UserPrincipal) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.requestedBy, principalKey(user)),
            cursor ? lt(documents.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(documents.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows.map(({ runToken: _token, ...row }) => row);
      cursor = rows[rows.length - 1]!.id;
    }
  }

  /** Their account is deleted: the documents stay with their records, asked for by nobody. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .update(documents)
      .set({ requestedBy: ANONYMIZED_UPLOADER })
      .where(eq(documents.requestedBy, principalKey(user)));
  }
}

/** The states a render may claim, and fail from. */
const OPEN: DocumentStatus[] = ['queued', 'rendering'];

/** A document that can't be issued, for a reason people can act on: not retried. */
class DocumentFailure extends Error {}

/**
 * This run lost its claim to another one, which goes on: the job stops
 * without retries, and its failure must not fail the document (the
 * processor's `failed` handler skips it).
 */
export class DocumentClaimLost extends UnrecoverableError {}

/** Another run claimed the document since this one did. */
class ClaimLost extends Error {
  constructor(id: string) {
    super(`Document ${id} is held by another run: this one stops.`);
  }
}

/**
 * Where a run's PDF is on the private disk: one key per run, never shared,
 * under its tenant's prefix (`tenants/<id>/documents/…`, docs/tenancy.md).
 */
export const documentKey = (tenantId: string, id: string, runToken: string) =>
  tenantFileKey(tenantId, `documents/${id}/${runToken}.pdf`);

const publicReason = (error: unknown) =>
  error instanceof DocumentFailure
    ? error.message
    : error instanceof PdfRejectedError
      ? DOCUMENT_ERRORS.rejected
      : DOCUMENT_ERRORS.unavailable;

/** A document as a record's documents list shows it. */
const listed = (
  row: DocumentRow,
  names: ReadonlyMap<string, string | null>,
): RecordDocumentView => ({
  id: row.id,
  status: row.status,
  template: row.source,
  language: row.locale,
  issuedBy: { key: row.requestedBy, name: names.get(row.requestedBy) ?? null },
  createdAt: row.createdAt.toISOString(),
  finishedAt:
    row.status === 'completed'
      ? (row.issuedAt ?? row.updatedAt).toISOString()
      : row.status === 'failed'
        ? row.updatedAt.toISOString()
        : null,
  attachmentId: row.attachmentId,
  error: row.error,
});

const view = (row: DocumentRow): DocumentView => ({
  id: row.id,
  source: row.source,
  subject: row.subject,
  recordId: row.recordId,
  locale: row.locale,
  status: row.status,
  attachmentId: row.attachmentId,
  error: row.error,
  issuedAt: row.issuedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
