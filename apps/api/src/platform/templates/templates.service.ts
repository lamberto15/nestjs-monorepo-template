import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  and,
  count,
  eq,
  getTableColumns,
  inArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
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
import { requireTenantId, tenantKey } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { organizationalUnits } from '../../iam/iam.tables.js';
import { OrganizationalUnitsService } from '../../iam/access/organizational-units.service.js';
import { defineResource } from '../../iam/resources/resource.js';
import {
  type PersonalDataSource,
  PersonalDataRegistry,
} from '../account/personal-data.registry.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { TEMPLATE_LIST } from './template.list.js';
import type {
  CreateTemplateDto,
  UpdateTemplateDto,
} from './template.schemas.js';
import { TemplatesRegistry } from './templates.registry.js';
import {
  recordTemplates,
  type RecordTemplateRow,
  type TemplateVisibility,
} from './templates.tables.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';

/** Audited as `recordTemplate.created`, `recordTemplate.updated` (what changed), `recordTemplate.deleted`. */
export const RECORD_TEMPLATE = defineResource({
  subject: 'RecordTemplate',
  audit: {},
});

/** At most this many templates per owner. */
export const MAX_TEMPLATES_PER_OWNER = 100;

/** Set by the system when a record is created (its number's series): never a template's value. */
const SYSTEM_FIELDS = new Set(['namingSeriesId']);

/** A value a template holds that the create route would not take as it is now. */
export interface DroppedValue {
  field: string;
  reason: 'unknown' | 'invalid' | 'forbidden';
  message: string;
}

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** What a name is unique within, with the subject. */
const scopeOf = (
  visibility: TemplateVisibility,
  owner: string,
  unitId: string | null,
) =>
  visibility === 'private'
    ? owner
    : visibility === 'unit'
      ? `unit:${unitId}`
      : 'tenant';

/**
 * Record templates: values to prefill a new record, kept under a name,
 * private to their owner, shared with a unit, or tenant-wide. A template
 * never creates anything and never bypasses a check: it is validated
 * against the subject's create schema and the saver's field permissions
 * when saved, and again when previewed for whoever uses it (a value the
 * schema or their permissions no longer allow is dropped and reported); the
 * client then creates the record through the subject's own route.
 */
@Injectable()
export class TemplatesService implements PersonalDataSource {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: TemplatesRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly units: OrganizationalUnitsService,
    private readonly customFields: CustomFieldsService,
    personalData: PersonalDataRegistry,
  ) {
    personalData.register(this);
  }

  /** As a personal data source: the person's templates are in their export… */
  readonly name = 'recordTemplate';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(recordTemplates)
      .where(eq(recordTemplates.owner, principalKey(user)));
    if (rows.length) yield rows.map((row) => this.template(user, row, false));
  }

  /**
   * …and go with their account: private templates are theirs alone and are
   * deleted; shared ones stay for the unit or tenant, ownerless
   * (`anonymous`), changeable by template managers only.
   */
  async erase(tx: Transaction, user: UserPrincipal) {
    const owner = principalKey(user);
    await tx
      .delete(recordTemplates)
      .where(
        and(
          eq(recordTemplates.owner, owner),
          eq(recordTemplates.visibility, 'private'),
        ),
      );
    await tx
      .update(recordTemplates)
      .set({ owner: 'anonymous' })
      .where(eq(recordTemplates.owner, owner));
  }

  /** The subjects that take templates and the principal may create, with the fields they may set. */
  async subjects(principal: RequestPrincipal) {
    const items = await Promise.all(
      this.registry.subjects().map(async (subject) => {
        if (!(await this.access.can(principal, 'create', subject))) {
          return null;
        }
        const denied = new Set(
          await this.access.deniedFields(principal, 'create', subject),
        );
        const fields = Object.keys(this.registry.get(subject)!.create.shape)
          .filter((field) => !SYSTEM_FIELDS.has(field) && !denied.has(field))
          .sort((a, b) => a.localeCompare(b));
        return { subject, fields };
      }),
    );
    return { items: items.filter((item) => item !== null) };
  }

  /** A page of the templates the principal sees (theirs, their units', the tenant's) of the records they may create. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const creatable = (await this.subjects(principal)).items.map(
      (item) => item.subject,
    );
    const where = and(
      await this.visibleTo(principal),
      creatable.length
        ? inArray(recordTemplates.subject, creatable)
        : sql`false`,
      TEMPLATE_LIST.where(query),
    );
    const manager = await this.isManager(principal);
    const [rows, total] = await Promise.all([
      this.db
        // With the sort values the cursor needs (lower(name)); pick() drops them.
        .select({
          ...getTableColumns(recordTemplates),
          ...TEMPLATE_LIST.sortSelect(query),
        })
        .from(recordTemplates)
        .where(and(where, afterCursor(recordTemplates.id, query)))
        .orderBy(...pageOrder(recordTemplates.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordTemplates, where, query),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row) => this.template(principal, row, manager)),
    };
  }

  async get(principal: RequestPrincipal, id: string) {
    return this.template(
      principal,
      await this.findVisible(principal, id),
      await this.isManager(principal),
    );
  }

  async create(
    principal: RequestPrincipal,
    dto: CreateTemplateDto,
    ip?: string,
  ) {
    await this.assertSaveable(principal, dto.subject, dto.values);
    const owner = principalKey(principal);
    const unitId = dto.unitId ?? null;
    await this.assertMayShare(principal, dto.visibility, unitId);
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.assertRoomFor(owner);
      const [created] = await tx
        .insert(recordTemplates)
        .values({
          subject: dto.subject,
          name: dto.name,
          visibility: dto.visibility,
          owner,
          unitId,
          scope: scopeOf(dto.visibility, owner, unitId),
          values: dto.values,
        })
        .returning()
        .catch((error: unknown) => {
          throw uniqueToConflict(error, this.taken(dto.subject, dto.name));
        });
      await this.audit.recordChange(
        principal,
        RECORD_TEMPLATE,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    });
    return this.template(principal, row, await this.isManager(principal));
  }

  /** Only what is sent changes; its owner, or a template manager for a shared one. */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateTemplateDto,
    ip?: string,
  ) {
    const found = await this.findVisible(principal, id);
    const manager = await this.isManager(principal);
    this.assertMayChange(principal, found, manager);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateTemplateDto;
    if (Object.keys(values).length === 0) {
      return this.template(principal, found, manager);
    }
    const visibility = values.visibility ?? found.visibility;
    const reshare =
      values.visibility !== undefined || values.unitId !== undefined;
    // A unit is named only for a unit template; leaving `unit` forgets it.
    const unitId =
      visibility === 'unit'
        ? values.unitId !== undefined
          ? values.unitId
          : found.unitId
        : null;
    if (visibility === 'unit' && !unitId) {
      throw invalid([
        {
          path: 'unitId',
          message: 'A unit template names its unit (unitId).',
        },
      ]);
    }
    if (visibility !== 'unit' && values.unitId) {
      throw invalid([
        { path: 'unitId', message: 'Only a unit template has a unit.' },
      ]);
    }
    if (reshare) {
      if (visibility === 'private' && found.owner !== principalKey(principal)) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: "Only a template's owner makes it private.",
        });
      }
      if (visibility !== found.visibility || unitId !== found.unitId) {
        await this.assertMayShare(principal, visibility, unitId);
      }
    }
    if (values.values !== undefined) {
      await this.assertSaveable(principal, found.subject, values.values);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(recordTemplates)
        .set({
          ...(values.name !== undefined && { name: values.name }),
          ...(values.values !== undefined && { values: values.values }),
          ...(reshare && {
            visibility,
            unitId,
            scope: scopeOf(visibility, found.owner, unitId),
          }),
        })
        .where(eq(recordTemplates.id, id))
        .returning()
        .catch((error: unknown) => {
          throw uniqueToConflict(
            error,
            this.taken(found.subject, values.name ?? found.name),
          );
        });
      await this.audit.recordChange(
        principal,
        RECORD_TEMPLATE,
        { action: 'updated', id, before: found, after: updated! },
        tx,
        ip,
      );
      return updated!;
    });
    return this.template(principal, row, manager);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const found = await this.findVisible(principal, id);
    this.assertMayChange(principal, found, await this.isManager(principal));
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(recordTemplates).where(eq(recordTemplates.id, id));
      await this.audit.recordChange(
        principal,
        RECORD_TEMPLATE,
        { action: 'deleted', id, before: found },
        tx,
        ip,
      );
    });
  }

  /**
   * The template as the caller may use it now: every value checked again
   * against the subject's create schema as it is and the caller's own field
   * permissions. A value that fails is left out and named in `dropped`
   * (the template is stale: change it); the caller needs the permission to
   * create the subject. The result is only a body to prefill a form with:
   * the create route validates and authorizes it all again.
   */
  async preview(principal: RequestPrincipal, id: string) {
    const found = await this.findVisible(principal, id);
    await this.assertMayCreate(principal, found.subject);
    const { values, dropped } = await this.inspect(
      principal,
      found.subject,
      found.values,
    );
    return {
      template: this.template(
        principal,
        found,
        await this.isManager(principal),
      ),
      values,
      dropped,
    };
  }

  /**
   * Each value of a template against the subject's create schema (a value
   * at a time: the schema's required fields may be missing from a
   * template) and the principal's permission to set that field. Custom
   * values are checked per key against the tenant's active fields.
   */
  private async inspect(
    principal: RequestPrincipal,
    subject: string,
    input: Record<string, unknown>,
  ) {
    const source = this.registry.get(subject);
    if (!source) {
      throw invalid([
        {
          path: 'subject',
          message: `"${subject}" takes no templates: one of ${this.registry.subjects().join(', ')}`,
        },
      ]);
    }
    const shape = source.create.shape;
    const values: Record<string, unknown> = {};
    const dropped: DroppedValue[] = [];
    const drop = (
      field: string,
      reason: DroppedValue['reason'],
      message: string,
    ) => void dropped.push({ field, reason, message });
    const forbidden = new Set(
      await this.access.forbiddenFields(principal, 'create', subject, input),
    );
    for (const [field, value] of Object.entries(input)) {
      if (!(field in shape) || SYSTEM_FIELDS.has(field)) {
        drop(field, 'unknown', 'Not a field a create takes.');
      } else if (forbidden.has(field)) {
        drop(field, 'forbidden', `You may not set ${field}.`);
      } else if (field === 'custom') {
        const kept = await this.inspectCustom(subject, value, drop);
        if (Object.keys(kept).length) values.custom = kept;
      } else {
        const parsed = shape[field]!.safeParse(value);
        if (parsed.success) {
          values[field] = value;
        } else {
          drop(field, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid.');
        }
      }
    }
    return { values, dropped };
  }

  private async inspectCustom(
    subject: string,
    value: unknown,
    drop: (field: string, reason: DroppedValue['reason'], m: string) => void,
  ) {
    const kept: Record<string, unknown> = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      drop('custom', 'invalid', 'Custom values are an object by key.');
      return kept;
    }
    for (const [key, one] of Object.entries(value)) {
      try {
        // Update mode: only the keys given are checked, required ones may be missing.
        await this.customFields.parseValues(subject, { [key]: one }, 'update');
        kept[key] = one;
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        const first = (
          error.getResponse() as { errors?: { message: string }[] }
        ).errors?.[0];
        drop(`custom.${key}`, 'invalid', first?.message ?? 'Invalid.');
      }
    }
    return kept;
  }

  /** A 403 unless the principal may create the subject's records: a template is only worth what a create is. */
  private async assertMayCreate(principal: RequestPrincipal, subject: string) {
    if (!(await this.access.can(principal, 'create', subject))) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: `You may not create ${subject}.`,
      });
    }
  }

  /**
   * What a template may hold when saved: the subject takes templates, the
   * saver may create it, and every value passes `inspect()` (a 400 naming
   * `values.<field>`, a 403 `field_forbidden` for fields they may not set).
   */
  private async assertSaveable(
    principal: RequestPrincipal,
    subject: string,
    input: Record<string, unknown>,
  ) {
    await this.assertMayCreate(principal, subject);
    const { dropped } = await this.inspect(principal, subject, input);
    const refused = dropped.filter((item) => item.reason !== 'forbidden');
    if (refused.length) {
      throw invalid(
        refused.map((item) => ({
          path: `values.${item.field}`,
          message: item.message,
        })),
      );
    }
    if (dropped.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not set: ${dropped.map((item) => item.field).join(', ')}.`,
        fields: dropped.map((item) => item.field),
      });
    }
  }

  /** A template manager: users only, not while impersonating (as every Access permission). */
  private async isManager(principal: RequestPrincipal) {
    return (
      principal.kind === 'user' &&
      !principal.impersonator &&
      (await this.access.can(principal, 'manageTemplates', 'Access'))
    );
  }

  /** Who may share with a unit (a current member of it, or a manager) or the tenant (a manager). */
  private async assertMayShare(
    principal: RequestPrincipal,
    visibility: TemplateVisibility,
    unitId: string | null,
  ) {
    if (visibility === 'private') {
      return;
    }
    const manager = await this.isManager(principal);
    if (visibility === 'tenant') {
      if (!manager) {
        throw new ForbiddenException({
          code: 'forbidden',
          message:
            'Sharing a template with everyone takes Access.manageTemplates.',
        });
      }
      return;
    }
    const [unit] = await this.db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(
        and(
          eq(organizationalUnits.id, unitId!),
          eq(organizationalUnits.tenantId, requireTenantId('A template')),
        ),
      );
    if (!unit) {
      throw invalid([{ path: 'unitId', message: 'No such unit.' }]);
    }
    if (
      !manager &&
      !(
        principal.kind === 'user' &&
        (await this.units.unitsOf(principal.id)).includes(unit.id)
      )
    ) {
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          'Sharing a template with a unit takes belonging to it, or Access.manageTemplates.',
      });
    }
  }

  /** Its owner changes a template; a shared one, a template manager too. */
  private assertMayChange(
    principal: RequestPrincipal,
    row: RecordTemplateRow,
    manager: boolean,
  ) {
    if (!this.mayChange(principal, row, manager)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only a template's owner changes it.",
      });
    }
  }

  private mayChange(
    principal: RequestPrincipal,
    row: RecordTemplateRow,
    manager: boolean,
  ) {
    return (
      row.owner === principalKey(principal) ||
      (manager && row.visibility !== 'private')
    );
  }

  private template(
    principal: RequestPrincipal,
    row: RecordTemplateRow,
    manager: boolean,
  ) {
    return {
      id: row.id,
      subject: row.subject,
      name: row.name,
      visibility: row.visibility,
      unitId: row.unitId,
      owner: row.owner,
      mine: row.owner === principalKey(principal),
      editable: this.mayChange(principal, row, manager),
      values: row.values,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The SQL condition for the templates the principal sees: theirs, their units', the tenant's. */
  private async visibleTo(principal: RequestPrincipal): Promise<SQL> {
    const unitIds =
      principal.kind === 'user' ? await this.units.unitsOf(principal.id) : [];
    return or(
      // Theirs whatever it is shared with: an administrator shares with a unit they aren't in.
      eq(recordTemplates.owner, principalKey(principal)),
      eq(recordTemplates.visibility, 'tenant'),
      unitIds.length
        ? and(
            eq(recordTemplates.visibility, 'unit'),
            inArray(recordTemplates.unitId, unitIds),
          )
        : undefined,
    )!;
  }

  /** A template the principal sees (and whose records they may create), else a 404 as for one that doesn't exist. */
  private async findVisible(principal: RequestPrincipal, id: string) {
    const [row] = await this.db
      .select()
      .from(recordTemplates)
      .where(and(eq(recordTemplates.id, id), await this.visibleTo(principal)));
    if (!row || !(await this.access.can(principal, 'create', row.subject))) {
      throw new NotFoundException(`Template ${id} not found.`);
    }
    return row;
  }

  private taken(subject: string, name: string) {
    return `A template named "${name}" of ${subject} exists where you save it.`;
  }

  /** A 400 when the owner has MAX_TEMPLATES_PER_OWNER templates already. */
  private async assertRoomFor(owner: string) {
    // One count at a time per owner (in the caller's transaction).
    await this.db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${tenantKey(`templates:${owner}`)}))`,
    );
    const [row] = await this.db
      .select({ templates: count() })
      .from(recordTemplates)
      .where(eq(recordTemplates.owner, owner));
    if ((row?.templates ?? 0) >= MAX_TEMPLATES_PER_OWNER) {
      throw invalid([
        {
          path: 'name',
          message: `At most ${MAX_TEMPLATES_PER_OWNER} templates: delete one first.`,
        },
      ]);
    }
  }
}
