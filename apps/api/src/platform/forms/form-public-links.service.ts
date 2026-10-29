import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { fieldsOf, type FormDefinition } from './form-schema.js';
import { FORMS_ENABLED } from './form-settings.js';
import type { CreatePublicLinkDto, PublicSubmitDto } from './form.schemas.js';
import { FormSubmissionsService } from './form-submissions.service.js';
import { FormsService } from './forms.service.js';
import {
  type FormPublicLinkRow,
  type FormRow,
  formPublicLinks,
  forms,
} from './forms.tables.js';

/** Working links a form may have at once. */
export const MAX_PUBLIC_LINKS = 5;
/** The longest a link may work, and how long it works when no end is given. */
export const PUBLIC_LINK_MAX_DAYS = 365;
export const PUBLIC_LINK_DEFAULT_DAYS = 30;
/** The most submissions a link takes, at most, and when none is given. */
export const PUBLIC_LINK_MAX_SUBMISSIONS = 100_000;
export const PUBLIC_LINK_DEFAULT_SUBMISSIONS = 1_000;

const DAY = 24 * 60 * 60 * 1000;

/** `frm_<tenant id>_<secret>`: the tenant, so the link is read in its scope. */
const TOKEN =
  /^frm_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

const hashOf = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

/**
 * Every refusal of a public link: forged, of another tenant or a tenant
 * gone, expired, revoked, used up, its form archived, unpublished or with
 * forms turned off. One answer, so a link says nothing of which tenants or
 * forms exist.
 */
const notFound = () =>
  new NotFoundException({
    code: 'form_link_not_found',
    message: t('auth.invalidLink'),
  });

/** Whether a definition has a field whose choices come from a source (not for anonymous people). */
const hasSources = (definition: FormDefinition) =>
  fieldsOf(definition).some((field) => field.optionsSource !== undefined);

const view = (row: FormPublicLinkRow) => ({
  id: row.id,
  formId: row.formId,
  createdBy: row.createdBy,
  expiresAt: row.expiresAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
  maxSubmissions: row.maxSubmissions,
  submissions: row.submissions,
  lastSubmittedAt: row.lastSubmittedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Public forms (docs/forms.md, "Public forms"): an editor publishes a form
 * to anyone holding a link, explicitly, one link at a time; the link
 * expires, can be revoked, and takes at most `maxSubmissions`. Whoever
 * holds it reads the published version and submits it with no account,
 * as nobody (`public:<link id>`, audited as `anonymous`): no other right,
 * no option source, no file. Only the token's hash is kept.
 */
@Injectable()
export class FormPublicLinksService {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly forms: FormsService,
    private readonly submissions: FormSubmissionsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  /** A form's links, newest first (never their tokens). */
  async list(principal: RequestPrincipal, formId: string) {
    await this.forms.editable(principal, formId);
    const rows = await this.db
      .select()
      .from(formPublicLinks)
      .where(eq(formPublicLinks.formId, formId))
      .orderBy(desc(formPublicLinks.id));
    return { items: rows.map(view) };
  }

  /** A new link, its token shown this once (`url`). Audited `form.link-created`. */
  async create(
    principal: RequestPrincipal,
    formId: string,
    dto: CreatePublicLinkDto,
    ip?: string,
  ) {
    if (principal.kind !== 'user') {
      // A link is someone's decision: an API client makes none.
      throw new ForbiddenException('Only a member makes a public link.');
    }
    const form = await this.forms.editable(principal, formId);
    if (form.publishedVersion !== null) {
      const current = await this.forms.currentVersion(form);
      if (hasSources(current.definition)) {
        throw sourced();
      }
    }
    const now = Date.now();
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(now + PUBLIC_LINK_DEFAULT_DAYS * DAY);
    if (
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > now + PUBLIC_LINK_MAX_DAYS * DAY
    ) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: [
          {
            path: 'expiresAt',
            message: `In the future, within ${PUBLIC_LINK_MAX_DAYS} days.`,
          },
        ],
      });
    }
    const tenantId = this.tenancy.tenantId('A public form link');
    const token = `frm_${tenantId}_${randomBytes(32).toString('base64url')}`;
    const row = await inTransaction(this.txHost, async (tx) => {
      // The form locked: two editors can't both make the fifth link.
      await tx
        .select({ id: forms.id })
        .from(forms)
        .where(eq(forms.id, formId))
        .for('update');
      const [{ open }] = await tx
        .select({ open: count() })
        .from(formPublicLinks)
        .where(and(eq(formPublicLinks.formId, formId), working()));
      if (open >= MAX_PUBLIC_LINKS) {
        throw new BadRequestException(
          `At most ${MAX_PUBLIC_LINKS} working public links per form: revoke one first.`,
        );
      }
      const [created] = await tx
        .insert(formPublicLinks)
        .values({
          formId,
          tokenHash: hashOf(token),
          createdBy: principalKey(principal),
          expiresAt,
          maxSubmissions: dto.maxSubmissions ?? PUBLIC_LINK_DEFAULT_SUBMISSIONS,
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'form.link-created',
          targetType: 'form',
          targetId: formId,
          details: {
            linkId: created!.id,
            expiresAt: expiresAt.toISOString(),
            maxSubmissions: created!.maxSubmissions,
          },
          ip,
        },
        tx,
      );
      return created!;
    });
    return {
      ...view(row),
      token,
      url: `${webUrl(this.config)}/public-form#${token}`,
    };
  }

  /** Ends a link now, for good. Audited `form.link-revoked`. */
  async revoke(
    principal: RequestPrincipal,
    formId: string,
    linkId: string,
    ip?: string,
  ) {
    await this.forms.editable(principal, formId);
    const row = await inTransaction(this.txHost, async (tx) => {
      const [revoked] = await tx
        .update(formPublicLinks)
        .set({ revokedAt: new Date(), revokedBy: principalKey(principal) })
        .where(
          and(
            eq(formPublicLinks.id, linkId),
            eq(formPublicLinks.formId, formId),
            isNull(formPublicLinks.revokedAt),
          ),
        )
        .returning();
      if (!revoked) {
        throw new NotFoundException(`No working link ${linkId} of this form.`);
      }
      await this.audit.record(
        principal,
        {
          action: 'form.link-revoked',
          targetType: 'form',
          targetId: formId,
          details: { linkId },
          ip,
        },
        tx,
      );
      return revoked;
    });
    return view(row);
  }

  /** What the link opens: the published version's name and definition, nothing of the tenant. */
  async open(token: string) {
    return this.inTenantOf(token, async (_link, form) => {
      const version = await this.forms.currentVersion(form);
      if (hasSources(version.definition)) throw notFound();
      return {
        name: form.name,
        description: form.description,
        versionId: version.id,
        version: version.version,
        definition: version.definition,
      };
    });
  }

  /**
   * Answers through the link, as nobody: checked like any submission
   * (FormSubmissionsService.answer), the link's quota taken in the same
   * transaction (a used-up link refuses, whatever the race). Audited
   * `form.submitted` by `anonymous`, without the answers.
   */
  async submit(dto: PublicSubmitDto, ip?: string) {
    return this.inTenantOf(dto.token, async (link, form) => {
      const version = await this.forms.currentVersion(form);
      if (hasSources(version.definition)) throw notFound();
      const submission = await this.submissions.answer({
        principal: null,
        submittedBy: `public:${link.id}`,
        form,
        dto: { versionId: dto.versionId, answers: dto.answers },
        ip,
        during: async (tx) => {
          const [taken] = await tx
            .update(formPublicLinks)
            .set({
              submissions: sql`${formPublicLinks.submissions} + 1`,
              lastSubmittedAt: new Date(),
            })
            .where(
              and(
                eq(formPublicLinks.id, link.id),
                working(),
                lt(formPublicLinks.submissions, formPublicLinks.maxSubmissions),
              ),
            )
            .returning({ id: formPublicLinks.id });
          if (!taken) throw notFound();
        },
      });
      // What the person sent, as stored: nothing of who else answered.
      return {
        id: submission.id,
        version: submission.version,
        createdAt: submission.createdAt,
      };
    });
  }

  /**
   * Runs `work` in the link's tenant with the working link and its active,
   * published form, forms turned on; every refusal the one 404.
   */
  private async inTenantOf<T>(
    token: string,
    work: (link: FormPublicLinkRow, form: FormRow) => Promise<T>,
  ) {
    const tenantId = TOKEN.exec(token)?.[1];
    if (!tenantId) throw notFound();
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant?.active) throw notFound();
    return this.tenancy.run(tenantId, async () => {
      const [found] = await this.db
        .select({ link: formPublicLinks, form: forms })
        .from(formPublicLinks)
        .innerJoin(forms, eq(forms.id, formPublicLinks.formId))
        .where(
          and(
            eq(formPublicLinks.tokenHash, hashOf(token)),
            working(),
            lt(formPublicLinks.submissions, formPublicLinks.maxSubmissions),
          ),
        );
      if (
        !found ||
        found.form.status !== 'active' ||
        found.form.publishedVersion === null ||
        !(await this.settings.enabled(FORMS_ENABLED, null))
      ) {
        throw notFound();
      }
      return work(found.link, found.form);
    });
  }
}

/** A link that works: not revoked, not expired. */
const working = () =>
  and(
    isNull(formPublicLinks.revokedAt),
    gt(formPublicLinks.expiresAt, new Date()),
  );

const sourced = () =>
  new BadRequestException({
    code: 'form_link_sources',
    message:
      'The published version has a field whose choices come from a source: a public form takes listed options only.',
  });
