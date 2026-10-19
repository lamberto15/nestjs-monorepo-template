import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fieldsRead } from '../../core/http/list-query.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { ApprovalsRegistry } from '../approvals/approvals.registry.js';
import { attachmentLimits } from '../attachments/attachment-limits.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { PdfRenderer } from '../documents/pdf-renderer.js';
import type { PlatformEnv } from '../platform.env.js';
import { switchedOn } from '../switches.js';
import { listCapabilities } from './list-capabilities.js';
import { listMetadata } from './list-metadata.js';
import type { ListMetadata } from './list-metadata.schemas.js';
import { ListsRegistry, type ListSource } from './lists.registry.js';

/**
 * Lists described for clients (GET /v1/lists/{subject}): a subject's
 * registered list declaration, with the custom fields its tenant has now,
 * less what the caller's field-level permissions hide.
 */
@Injectable()
export class ListsService {
  constructor(
    private readonly registry: ListsRegistry,
    private readonly access: AccessService,
    private readonly customFields: CustomFieldsService,
    private readonly pdf: PdfRenderer,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsRegistry,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  /** The subject's list, or a 404: before any permission is checked. */
  source(subject: string): ListSource {
    const source = this.registry.get(subject);
    if (!source) {
      throw new NotFoundException(`${subject} has no list.`);
    }
    return source;
  }

  /**
   * The list as `principal` may use it. Custom fields are the request's
   * tenant's (CustomFieldsService reads them behind row-level security);
   * a field the principal may read on no record is left out, so the
   * description shows nothing the list's items would hide; one it may
   * read on some records only is neither filterable nor sortable (nor `q`
   * when it reads one), only selectable.
   */
  async describe(principal: Principal, subject: string): Promise<ListMetadata> {
    const source = this.source(subject);
    const takesCustom = this.customFields.subjects().includes(subject);
    const [list, definitions, denied, conditional, restore] = await Promise.all(
      [
        takesCustom
          ? this.customFields.extendList(source.list, subject)
          : source.list,
        takesCustom ? this.customFields.definitions(subject) : [],
        this.access.deniedFields(principal, 'read', subject),
        this.access.conditionalFields(principal, 'read', subject),
        source.list.options.softDelete
          ? this.access.can(principal, 'restore', subject)
          : false,
      ],
    );
    const capabilities = this.capabilities(source);
    const hiddenFields = new Set(denied);
    const conditionalFields = new Set(conditional);
    // The list routes refuse the same names (AccessService.assertQueryFields).
    const hidden = (name: string) =>
      fieldsRead(list.fields, name).some((field) => hiddenFields.has(field));
    const unmatchable = (name: string) =>
      fieldsRead(list.fields, name).some((field) =>
        conditionalFields.has(field),
      );
    return {
      ...listMetadata(subject, list, {
        hidden,
        unmatchable,
        labels: new Map(definitions.map((field) => [field.key, field.label])),
        recycleBin: restore,
      }),
      capabilities,
      // What the upload route enforces (AttachmentUpload reads the same).
      attachmentLimits: source.capabilities.includes('attachments')
        ? attachmentLimits(this.config)
        : null,
      // What POST …/{id}/pdf issues (DocumentsService reads the same registry).
      documentTemplates: capabilities.pdf
        ? this.documents.templatesOf(subject)
        : null,
    };
  }

  /**
   * What the subject's records take in this deployment: the declared
   * capabilities, each switch read as its module reads it (documents
   * through `PdfRenderer.enabled`, as GET /v1/features; WEBHOOKS through
   * `switchedOn()`), and its approvable actions (ApprovalsRegistry).
   */
  private capabilities(source: ListSource) {
    return listCapabilities(source.capabilities, {
      documents: this.pdf.enabled,
      webhooks: switchedOn('WEBHOOKS'),
      approvals: this.approvals
        .actions()
        .some(({ declaration }) => declaration.subject === source.subject),
    });
  }
}
