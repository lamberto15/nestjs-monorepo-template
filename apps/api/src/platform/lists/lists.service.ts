import { Injectable, NotFoundException } from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
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
   * description shows nothing the list's items would hide.
   */
  async describe(principal: Principal, subject: string): Promise<ListMetadata> {
    const source = this.source(subject);
    const takesCustom = this.customFields.subjects().includes(subject);
    const [list, definitions, denied, restore] = await Promise.all([
      takesCustom
        ? this.customFields.extendList(source.list, subject)
        : source.list,
      takesCustom ? this.customFields.definitions(subject) : [],
      this.access.deniedFields(principal, 'read', subject),
      source.list.options.softDelete
        ? this.access.can(principal, 'restore', subject)
        : false,
    ]);
    const hiddenFields = new Set(denied);
    const hidden = (name: string) =>
      [name, name.split('.')[0], source.fieldOf?.(name)].some(
        (field) => field !== undefined && hiddenFields.has(field),
      );
    return listMetadata(subject, list, {
      hidden,
      labels: new Map(definitions.map((field) => [field.key, field.label])),
      recycleBin: restore,
    });
  }
}
