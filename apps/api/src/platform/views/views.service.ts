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
import { fieldsRead, type ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  pageQuerySchema,
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
import { ListsRegistry } from '../lists/lists.registry.js';
import { ListsService } from '../lists/lists.service.js';
import { VIEW_LIST } from './view.list.js';
import type { CreateViewDto, UpdateViewDto } from './view.schemas.js';
import {
  type SavedViewRow,
  savedViews,
  type ViewVisibility,
} from './views.tables.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';

/** Audited as `view.created`, `view.updated` (what changed), `view.deleted`. */
export const SAVED_VIEW = defineResource({ subject: 'View', audit: {} });

/** At most this many saved views per owner. */
export const MAX_VIEWS_PER_OWNER = 100;

/** What a view never holds: paging and the other parameters a list route takes besides its filters. */
const NOT_A_FILTER = new Set([
  ...Object.keys(pageQuerySchema.shape),
  'fields',
  'deleted',
  'lang',
  'include',
]);

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** What a name is unique within, with the subject. */
const scopeOf = (
  visibility: ViewVisibility,
  owner: string,
  unitId: string | null,
) =>
  visibility === 'private'
    ? owner
    : visibility === 'unit'
      ? `unit:${unitId}`
      : 'tenant';

/**
 * Saved views: a list's filters, sort and columns kept under a name,
 * private to their owner, shared with a unit, or tenant-wide. The list is
 * any registered one (`ListsRegistry`), so a view works for every subject
 * without the subject knowing. A view is validated against the list (with
 * the tenant's custom fields) as the list route validates a query, when
 * saved and again when applied, then checked against the viewer's
 * field-level permissions: a filter, sort or search on a field they may not
 * read is a 403 (it would tell its value); a column they may not see is
 * left out.
 */
@Injectable()
export class ViewsService implements PersonalDataSource {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly lists: ListsService,
    private readonly registry: ListsRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly units: OrganizationalUnitsService,
    personalData: PersonalDataRegistry,
  ) {
    personalData.register(this);
  }

  /** As a personal data source: the person's views are in their export… */
  readonly name = 'view';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(savedViews)
      .where(eq(savedViews.owner, principalKey(user)));
    if (rows.length) yield rows.map((row) => this.view(user, row, false));
  }

  /**
   * …and go with their account: private views are theirs alone and are
   * deleted; shared ones stay for the unit or tenant, ownerless
   * (`anonymous`), changeable by view managers only.
   */
  async erase(tx: Transaction, user: UserPrincipal) {
    const owner = principalKey(user);
    await tx
      .delete(savedViews)
      .where(
        and(eq(savedViews.owner, owner), eq(savedViews.visibility, 'private')),
      );
    await tx
      .update(savedViews)
      .set({ owner: 'anonymous' })
      .where(eq(savedViews.owner, owner));
  }

  /** A page of the views the principal sees (theirs, their units', the tenant's) of the lists they may read. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const readable = await this.readableSubjects(principal);
    const where = and(
      await this.visibleTo(principal),
      readable.length ? inArray(savedViews.subject, readable) : sql`false`,
      VIEW_LIST.where(query),
    );
    const manager = await this.isManager(principal);
    const [rows, total] = await Promise.all([
      this.db
        // With the sort values the cursor needs (lower(name)); pick() drops them.
        .select({
          ...getTableColumns(savedViews),
          ...VIEW_LIST.sortSelect(query),
        })
        .from(savedViews)
        .where(and(where, afterCursor(savedViews.id, query)))
        .orderBy(...pageOrder(savedViews.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, savedViews, where, query),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row) => this.view(principal, row, manager)),
    };
  }

  async get(principal: RequestPrincipal, id: string) {
    return this.view(
      principal,
      await this.findVisible(principal, id),
      await this.isManager(principal),
    );
  }

  async create(principal: RequestPrincipal, dto: CreateViewDto, ip?: string) {
    if (!this.registry.get(dto.subject)) {
      throw invalid([
        {
          path: 'subject',
          message: `"${dto.subject}" has no list: one of ${this.registry.subjects().join(', ')}`,
        },
      ]);
    }
    await this.checkDefinition(
      principal,
      dto.subject,
      dto.query,
      dto.columns,
      'save',
    );
    const owner = principalKey(principal);
    const unitId = dto.unitId ?? null;
    await this.assertMayShare(principal, dto.visibility, unitId);
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.assertRoomFor(owner);
      const [created] = await tx
        .insert(savedViews)
        .values({
          subject: dto.subject,
          name: dto.name,
          visibility: dto.visibility,
          owner,
          unitId,
          scope: scopeOf(dto.visibility, owner, unitId),
          query: dto.query,
          columns: dto.columns,
        })
        .returning()
        .catch((error: unknown) => {
          throw uniqueToConflict(error, this.taken(dto.subject, dto.name));
        });
      await this.audit.recordChange(
        principal,
        SAVED_VIEW,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    });
    return this.view(principal, row, await this.isManager(principal));
  }

  /** Only what is sent changes; its owner, or a view manager for a shared one. */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateViewDto,
    ip?: string,
  ) {
    const view = await this.findVisible(principal, id);
    const manager = await this.isManager(principal);
    this.assertMayChange(principal, view, manager);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateViewDto;
    if (Object.keys(values).length === 0) {
      return this.view(principal, view, manager);
    }
    const visibility = values.visibility ?? view.visibility;
    const reshare =
      values.visibility !== undefined || values.unitId !== undefined;
    // A unit is named only for a unit view; leaving `unit` forgets it.
    const unitId =
      visibility === 'unit'
        ? values.unitId !== undefined
          ? values.unitId
          : view.unitId
        : null;
    if (visibility === 'unit' && !unitId) {
      throw invalid([
        { path: 'unitId', message: 'A unit view names its unit (unitId).' },
      ]);
    }
    if (visibility !== 'unit' && values.unitId) {
      throw invalid([
        { path: 'unitId', message: 'Only a unit view has a unit.' },
      ]);
    }
    if (reshare) {
      if (visibility === 'private' && view.owner !== principalKey(principal)) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: "Only a view's owner makes it private.",
        });
      }
      if (visibility !== view.visibility || unitId !== view.unitId) {
        await this.assertMayShare(principal, visibility, unitId);
      }
    }
    if (values.query !== undefined || values.columns !== undefined) {
      await this.checkDefinition(
        principal,
        view.subject,
        values.query ?? view.query,
        values.columns === undefined ? view.columns : values.columns,
        'save',
      );
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(savedViews)
        .set({
          ...(values.name !== undefined && { name: values.name }),
          ...(values.query !== undefined && { query: values.query }),
          ...(values.columns !== undefined && { columns: values.columns }),
          ...(reshare && {
            visibility,
            unitId,
            scope: scopeOf(visibility, view.owner, unitId),
          }),
        })
        .where(eq(savedViews.id, id))
        .returning()
        .catch((error: unknown) => {
          throw uniqueToConflict(
            error,
            this.taken(view.subject, values.name ?? view.name),
          );
        });
      await this.audit.recordChange(
        principal,
        SAVED_VIEW,
        { action: 'updated', id, before: view, after: updated! },
        tx,
        ip,
      );
      return updated!;
    });
    return this.view(principal, row, manager);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const view = await this.findVisible(principal, id);
    this.assertMayChange(principal, view, await this.isManager(principal));
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(savedViews).where(eq(savedViews.id, id));
      await this.audit.recordChange(
        principal,
        SAVED_VIEW,
        { action: 'deleted', id, before: view },
        tx,
        ip,
      );
    });
  }

  /**
   * The view as the viewer may use it, validated again against the list as
   * it is now (a custom field removed since makes a 400 naming the
   * parameter), their field permissions applied (a 403 `field_forbidden`
   * for a filter, sort or search on a field they may not read), and its
   * columns less those they may not see. `params` is the list route's query.
   */
  async apply(principal: RequestPrincipal, id: string) {
    const view = await this.findVisible(principal, id);
    const { hidden } = await this.checkDefinition(
      principal,
      view.subject,
      view.query,
      view.columns,
      'apply',
    );
    const columns = view.columns
      ? view.columns.filter((column) => !hidden(column))
      : null;
    const hiddenColumns = view.columns
      ? view.columns.filter((column) => hidden(column))
      : [];
    const shown = { ...view, columns };
    return {
      view: this.view(principal, shown, await this.isManager(principal)),
      params: {
        ...view.query,
        ...(columns?.length && { fields: columns.join(',') }),
      },
      columns,
      hiddenColumns,
    };
  }

  /**
   * The query and columns checked as the list route checks a request, as
   * 400s on `query.<parameter>` and `columns`: only the list's own filters
   * (no paging, `fields`, `deleted`, `lang`), every column one of its
   * `select`. Then the viewer's field permissions: a 403 `field_forbidden`
   * for a filter, sort or search on a field they may not read.
   */
  private async checkDefinition(
    principal: RequestPrincipal,
    subject: string,
    raw: Record<string, string>,
    columns: string[] | null,
    when: 'save' | 'apply',
  ) {
    if (!(await this.lists.mayRead(principal, subject))) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: `You may not read ${subject}.`,
      });
    }
    const list = await this.lists.extended(subject);
    const errors: { path: string; message: string }[] = [];
    const filters = Object.fromEntries(
      Object.entries(raw).filter(([key]) => {
        if (NOT_A_FILTER.has(key)) {
          errors.push({
            path: `query.${key}`,
            message: `A view holds filters, sort and search, not "${key}" (its columns are \`columns\`).`,
          });
          return false;
        }
        return true;
      }),
    );
    const parsed = list.schema.safeParse(filters);
    if (!parsed.success) {
      const stale =
        when === 'apply' ? ' (the list changed since the view was saved)' : '';
      for (const issue of parsed.error.issues) {
        // A parameter the list doesn't know is named by its key, not the root.
        const unknown =
          issue.code === 'unrecognized_keys' ? issue.keys : undefined;
        for (const path of unknown?.map((key) => [key]) ?? [issue.path]) {
          errors.push({
            path: ['query', ...path].join('.'),
            message: issue.message + stale,
          });
        }
      }
    }
    const select = list.options.select ?? [];
    for (const column of columns ?? []) {
      if (!select.includes(column)) {
        errors.push({
          path: 'columns',
          message: `Not a field of this list: ${column}`,
        });
      }
    }
    if (errors.length) {
      throw invalid(errors);
    }
    if (parsed.success) {
      await this.access.assertQueryFields(
        principal,
        subject,
        parsed.data as ListQuery,
      );
    }
    const denied = new Set(
      await this.access.deniedFields(principal, 'read', subject),
    );
    return {
      list,
      /** A column the viewer may not read: left out. */
      hidden: (column: string) =>
        fieldsRead(list.fields, column).some((field) => denied.has(field)),
    };
  }

  /** A view manager: users only, not while impersonating (as every Access permission). */
  private async isManager(principal: RequestPrincipal) {
    return (
      principal.kind === 'user' &&
      !principal.impersonator &&
      (await this.access.can(principal, 'manageViews', 'Access'))
    );
  }

  /** Who may share with a unit (a current member of it, or a manager) or the tenant (a manager). */
  private async assertMayShare(
    principal: RequestPrincipal,
    visibility: ViewVisibility,
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
          message: 'Sharing a view with everyone takes Access.manageViews.',
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
          eq(organizationalUnits.tenantId, requireTenantId('A view')),
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
          'Sharing a view with a unit takes belonging to it, or Access.manageViews.',
      });
    }
  }

  /** Its owner changes a view; a shared one, a view manager too. */
  private assertMayChange(
    principal: RequestPrincipal,
    view: SavedViewRow,
    manager: boolean,
  ) {
    if (!this.mayChange(principal, view, manager)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only a view's owner changes it.",
      });
    }
  }

  private mayChange(
    principal: RequestPrincipal,
    view: SavedViewRow,
    manager: boolean,
  ) {
    return (
      view.owner === principalKey(principal) ||
      (manager && view.visibility !== 'private')
    );
  }

  private view(
    principal: RequestPrincipal,
    row: SavedViewRow,
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
      query: row.query,
      columns: row.columns,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The SQL condition for the views the principal sees: theirs, their units', the tenant's. */
  private async visibleTo(principal: RequestPrincipal): Promise<SQL> {
    const unitIds =
      principal.kind === 'user' ? await this.units.unitsOf(principal.id) : [];
    return or(
      // Theirs whatever it is shared with: an administrator shares with a unit they aren't in.
      eq(savedViews.owner, principalKey(principal)),
      eq(savedViews.visibility, 'tenant'),
      unitIds.length
        ? and(
            eq(savedViews.visibility, 'unit'),
            inArray(savedViews.unitId, unitIds),
          )
        : undefined,
    )!;
  }

  /** The registered lists the principal may read (a view of another is not theirs to see). */
  private async readableSubjects(principal: RequestPrincipal) {
    const subjects = this.registry.subjects();
    const may = await Promise.all(
      subjects.map((subject) => this.lists.mayRead(principal, subject)),
    );
    return subjects.filter((_, index) => may[index]);
  }

  /** A view the principal sees (and whose list they may read), else a 404 as for one that doesn't exist. */
  private async findVisible(principal: RequestPrincipal, id: string) {
    const [row] = await this.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, id), await this.visibleTo(principal)));
    if (!row || !(await this.lists.mayRead(principal, row.subject))) {
      throw new NotFoundException(`View ${id} not found.`);
    }
    return row;
  }

  private taken(subject: string, name: string) {
    return `A view named "${name}" of ${subject} exists where you save it.`;
  }

  /** A 400 when the owner has MAX_VIEWS_PER_OWNER views already. */
  private async assertRoomFor(owner: string) {
    // One count at a time per owner (in the caller's transaction).
    await this.db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${tenantKey(`views:${owner}`)}))`,
    );
    const [row] = await this.db
      .select({ views: count() })
      .from(savedViews)
      .where(eq(savedViews.owner, owner));
    if ((row?.views ?? 0) >= MAX_VIEWS_PER_OWNER) {
      throw invalid([
        {
          path: 'name',
          message: `At most ${MAX_VIEWS_PER_OWNER} views: delete one first.`,
        },
      ]);
    }
  }
}
