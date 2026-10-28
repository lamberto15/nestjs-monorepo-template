import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, getTableColumns } from 'drizzle-orm';
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
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import {
  type PersonalDataSource,
  PersonalDataRegistry,
} from '../account/personal-data.registry.js';
import { RetentionRegistry } from '../retention/retention.registry.js';
import { checkAnswers } from './form-answers.js';
import { FORM_SUBMISSION_LIST } from './form.list.js';
import type { SubmitFormDto } from './form.schemas.js';
import { formSubmissions, formVersions } from './forms.tables.js';
import { FormsService, invalid } from './forms.service.js';

/** A submission row with its version's number. */
const columns = {
  ...getTableColumns(formSubmissions),
  version: formVersions.version,
};

type SubmissionRow = typeof formSubmissions.$inferSelect & { version: number };

const view = (row: SubmissionRow) => ({
  id: row.id,
  formId: row.formId,
  versionId: row.versionId,
  version: row.version,
  submittedBy: row.submittedBy,
  status: row.status,
  answers: row.answers,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Submissions (docs/forms.md, "Submissions"): answers checked on the
 * server against the exact published version they name, stored with it.
 * Those who may read responses see every submission of a form; a
 * submitter, only their own. The audit log says who submitted what form,
 * never the answers.
 */
@Injectable()
export class FormSubmissionsService implements PersonalDataSource {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly forms: FormsService,
    private readonly audit: AuditService,
    personalData: PersonalDataRegistry,
    retention: RetentionRegistry,
  ) {
    personalData.register(this);
    // Off until a tenant turns it on (docs/retention.md).
    retention.register({
      name: 'form-submission',
      label: 'Form submissions',
      subject: 'Form',
      table: formSubmissions,
      ageColumn: formSubmissions.createdAt,
      action: 'purge',
      defaultDays: 730,
      minDays: 30,
    });
  }

  /** As a personal data source: the person's answers are in their export… */
  readonly name = 'form-submission';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select(columns)
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
      .where(eq(formSubmissions.submittedBy, principalKey(user)));
    if (rows.length) yield rows.map(view);
  }

  /** …and go with their account: answers may say anything about them. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .delete(formSubmissions)
      .where(eq(formSubmissions.submittedBy, principalKey(user)));
  }

  async submit(
    principal: RequestPrincipal,
    formId: string,
    dto: SubmitFormDto,
    ip?: string,
  ) {
    const form = await this.forms.find(formId, {
      read: true,
      submit: true,
      edit: false,
      readResponses: false,
    });
    const current = await this.forms.currentVersion(form);
    if (dto.versionId !== current.id) {
      const [named] = await this.db
        .select({ id: formVersions.id })
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, dto.versionId),
            eq(formVersions.formId, formId),
          ),
        );
      if (!named) {
        throw invalid([
          { path: 'versionId', message: 'Not a version of this form.' },
        ]);
      }
      throw new ConflictException({
        code: 'form_version_outdated',
        message: `Version ${current.version} replaced the one answered: load it and answer again.`,
        versionId: current.id,
        version: current.version,
      });
    }
    const checked = checkAnswers(current.definition, dto.answers);
    if (!checked.ok) {
      throw invalid(checked.issues);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(formSubmissions)
        .values({
          formId,
          versionId: current.id,
          submittedBy: principalKey(principal),
          answers: checked.answers,
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'form.submitted',
          targetType: 'form-submission',
          targetId: created!.id,
          // Never the answers: they are the person's (docs/forms.md, "Audit").
          details: { formId, versionId: current.id, version: current.version },
          ip,
        },
        tx,
      );
      return created!;
    });
    return view({ ...row, version: current.version });
  }

  /** Every submission for those who read responses; a submitter's own otherwise; a 403 for anyone else. */
  private async scope(principal: RequestPrincipal, formId: string) {
    const rights = await this.forms.rights(principal);
    if (!rights.readResponses && !rights.submit) {
      throw new ForbiddenException();
    }
    await this.forms.find(formId, rights);
    return and(
      eq(formSubmissions.formId, formId),
      rights.readResponses
        ? undefined
        : eq(formSubmissions.submittedBy, principalKey(principal)),
    );
  }

  async page(principal: RequestPrincipal, formId: string, query: ListQuery) {
    const where = and(
      await this.scope(principal, formId),
      FORM_SUBMISSION_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select(columns)
        .from(formSubmissions)
        .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
        .where(and(where, afterCursor(formSubmissions.id, query)))
        .orderBy(...pageOrder(formSubmissions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, formSubmissions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async get(principal: RequestPrincipal, formId: string, id: string) {
    const [row] = await this.db
      .select(columns)
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
      .where(
        and(await this.scope(principal, formId), eq(formSubmissions.id, id)),
      );
    if (!row) {
      throw new NotFoundException(`Submission ${id} not found.`);
    }
    return view(row);
  }
}
